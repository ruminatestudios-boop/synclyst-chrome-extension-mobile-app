"""
Permanent API Keys — issue long-lived tokens for MCP / CLI usage.
Keys are prefixed `syn_live_` and stored (hashed) in Supabase.
"""
import hashlib
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import verify_clerk
from app.db import get_supabase

router = APIRouter()

_PREFIX = "syn_live_"
_KEY_TABLE = "user_api_keys"


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _generate_key() -> str:
    """Create a new `syn_live_<40 hex>` key."""
    return _PREFIX + secrets.token_hex(20)


def _hash_key(raw: str) -> str:
    """SHA-256 of the raw key — only the hash is persisted."""
    return hashlib.sha256(raw.encode()).hexdigest()


def lookup_api_key(supabase, raw_key: str) -> Optional[dict]:
    """
    Verify a raw API key against the Supabase table.
    Returns the row (with clerk_user_id) or None.
    """
    if not supabase or not raw_key.startswith(_PREFIX):
        return None
    h = _hash_key(raw_key)
    try:
        r = (
            supabase.table(_KEY_TABLE)
            .select("id, clerk_user_id, label, created_at, last_used_at, revoked")
            .eq("key_hash", h)
            .limit(1)
            .execute()
        )
        if not r.data:
            return None
        row = r.data[0]
        if row.get("revoked"):
            return None
        # Best-effort: update last_used_at in background (don't block response)
        try:
            supabase.table(_KEY_TABLE).update(
                {"last_used_at": datetime.now(timezone.utc).isoformat()}
            ).eq("id", row["id"]).execute()
        except Exception:
            pass
        return row
    except Exception:
        return None


# ─── Schemas ─────────────────────────────────────────────────────────────────

class CreateKeyRequest(BaseModel):
    label: str = "MCP key"


class CreateKeyResponse(BaseModel):
    id: str
    key: str          # shown ONCE — never stored in plain text
    label: str
    created_at: str


class ApiKeyMeta(BaseModel):
    id: str
    label: str
    created_at: str
    last_used_at: Optional[str] = None


# ─── Routes ──────────────────────────────────────────────────────────────────

@router.post("", response_model=CreateKeyResponse)
async def create_api_key(
    body: CreateKeyRequest,
    auth: dict = Depends(verify_clerk),
):
    """Generate a new permanent API key for the authenticated user."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    clerk_user_id = auth.get("sub")
    if not clerk_user_id:
        raise HTTPException(status_code=401, detail="Missing user id")

    # Limit: max 5 active keys per user
    try:
        existing = (
            supabase.table(_KEY_TABLE)
            .select("id", count="exact")
            .eq("clerk_user_id", clerk_user_id)
            .eq("revoked", False)
            .execute()
        )
        if existing.count and existing.count >= 5:
            raise HTTPException(
                status_code=400,
                detail="Maximum of 5 API keys reached. Revoke an existing key first.",
            )
    except HTTPException:
        raise
    except Exception:
        pass  # If count fails, allow creation

    raw_key = _generate_key()
    now = datetime.now(timezone.utc).isoformat()

    row = {
        "clerk_user_id": clerk_user_id,
        "key_hash": _hash_key(raw_key),
        "label": body.label[:80],
        "revoked": False,
        "created_at": now,
        "last_used_at": None,
    }

    try:
        r = supabase.table(_KEY_TABLE).insert(row).execute()
        if not r.data:
            raise ValueError("Insert returned no data")
        inserted = r.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create API key: {e}")

    return CreateKeyResponse(
        id=inserted["id"],
        key=raw_key,   # Only time we return the plaintext key
        label=inserted["label"],
        created_at=inserted["created_at"],
    )


@router.get("", response_model=list[ApiKeyMeta])
async def list_api_keys(auth: dict = Depends(verify_clerk)):
    """List all active API keys for the authenticated user (no plaintext keys)."""
    supabase = get_supabase()
    if not supabase:
        return []

    clerk_user_id = auth.get("sub")
    if not clerk_user_id:
        raise HTTPException(status_code=401, detail="Missing user id")

    try:
        r = (
            supabase.table(_KEY_TABLE)
            .select("id, label, created_at, last_used_at")
            .eq("clerk_user_id", clerk_user_id)
            .eq("revoked", False)
            .order("created_at", desc=True)
            .execute()
        )
        return [
            ApiKeyMeta(
                id=row["id"],
                label=row["label"],
                created_at=row["created_at"],
                last_used_at=row.get("last_used_at"),
            )
            for row in (r.data or [])
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{key_id}")
async def revoke_api_key(key_id: str, auth: dict = Depends(verify_clerk)):
    """Revoke (soft-delete) an API key. The user must own it."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    clerk_user_id = auth.get("sub")
    if not clerk_user_id:
        raise HTTPException(status_code=401, detail="Missing user id")

    try:
        r = (
            supabase.table(_KEY_TABLE)
            .update({"revoked": True})
            .eq("id", key_id)
            .eq("clerk_user_id", clerk_user_id)
            .execute()
        )
        if not r.data:
            raise HTTPException(status_code=404, detail="Key not found or already revoked")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"revoked": True, "id": key_id}
