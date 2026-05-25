"""
Developer API key management — /v1/developers/ routes.

Protected by existing Clerk JWT auth (same as all other internal routes).
Developers use the frontend dashboard at synclyst.app/developers/dashboard.

Endpoints:
  POST   /v1/developers/keys          — create new sk_live_ key
  POST   /v1/developers/keys/test     — create sk_test_ sandbox key
  GET    /v1/developers/keys          — list all active keys (masked)
  DELETE /v1/developers/keys/{id}     — revoke a key
  GET    /v1/developers/usage         — usage stats + 30-day daily graph
  POST   /v1/developers/subscribe     — create Stripe Checkout for developer plan
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import verify_clerk
from app.db import get_supabase

router = APIRouter()

_DEV_KEY_TABLE = "developer_api_keys"
_USAGE_TABLE = "developer_usage_log"
_SK_LIVE_PREFIX = "sk_live_"
_SK_TEST_PREFIX = "sk_test_"

VALID_PLANS = {"free", "starter", "pro", "enterprise"}

# Map plan → Stripe Price ID env var name (set in config.py)
_PLAN_PRICE_ENV = {
    "starter": "stripe_price_dev_starter",
    "pro": "stripe_price_dev_pro",
    "enterprise": "stripe_price_dev_enterprise",
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _generate_key(prefix: str) -> str:
    """Cryptographically random API key — 48 hex chars after prefix."""
    return prefix + secrets.token_hex(24)


def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _key_prefix_display(raw: str) -> str:
    """Return first 20 chars + ... for safe display (never reveal full key)."""
    return raw[:20] + "..."


# ─── Schemas ──────────────────────────────────────────────────────────────────

class CreateKeyRequest(BaseModel):
    label: str = "My API Key"
    plan: str = "free"


class CreateKeyResponse(BaseModel):
    id: str
    key: str          # shown ONCE — never stored plaintext
    key_prefix: str   # sk_live_XXXXXXXXXXXXXXXXXXXX...
    label: str
    plan: str
    created_at: str


class DevKeyMeta(BaseModel):
    id: str
    key_prefix: str
    label: str
    plan: str
    status: str
    calls_used_this_month: int
    calls_limit: Optional[int]
    created_at: str
    last_used_at: Optional[str] = None


class SubscribeRequest(BaseModel):
    plan: str
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


# ─── Routes ───────────────────────────────────────────────────────────────────

@router.post("", response_model=CreateKeyResponse)
async def create_developer_key(
    body: CreateKeyRequest,
    auth: dict = Depends(verify_clerk),
):
    """
    Generate a new developer API key (sk_live_...).
    The full key is returned ONCE and never stored in plaintext.
    Max 3 active live keys per account.
    """
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    developer_id = auth.get("sub")
    if not developer_id:
        raise HTTPException(status_code=401, detail="Missing user id")

    # Enforce per-account key limit
    try:
        existing = (
            supabase.table(_DEV_KEY_TABLE)
            .select("id", count="exact")
            .eq("developer_id", developer_id)
            .eq("status", "active")
            .execute()
        )
        if (existing.count or 0) >= 3:
            raise HTTPException(
                status_code=400,
                detail="Maximum of 3 active API keys per account. Revoke an existing key first.",
            )
    except HTTPException:
        raise
    except Exception:
        pass  # if count fails, allow creation

    plan = (body.plan or "free").lower()
    if plan not in VALID_PLANS:
        plan = "free"

    raw_key = _generate_key(_SK_LIVE_PREFIX)
    now = datetime.now(timezone.utc).isoformat()
    current_month = datetime.now(timezone.utc).strftime("%Y-%m")

    try:
        r = supabase.table(_DEV_KEY_TABLE).insert(
            {
                "developer_id": developer_id,
                "key_hash": _hash_key(raw_key),
                "key_prefix": _key_prefix_display(raw_key),
                "plan": plan,
                "status": "active",
                "label": body.label[:80],
                "calls_used_this_month": 0,
                "month_key": current_month,
                "created_at": now,
            }
        ).execute()
        if not r.data:
            raise ValueError("Insert returned no data")
        inserted = r.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create API key: {exc}")

    return CreateKeyResponse(
        id=inserted["id"],
        key=raw_key,
        key_prefix=_key_prefix_display(raw_key),
        label=inserted["label"],
        plan=inserted["plan"],
        created_at=inserted["created_at"],
    )


@router.post("/test", response_model=CreateKeyResponse)
async def create_test_key(
    body: CreateKeyRequest,
    auth: dict = Depends(verify_clerk),
):
    """
    Generate a sandbox test key (sk_test_...).
    Test keys return fake data and never charge real credits.
    """
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    developer_id = auth.get("sub")
    if not developer_id:
        raise HTTPException(status_code=401, detail="Missing user id")

    raw_key = _generate_key(_SK_TEST_PREFIX)
    now = datetime.now(timezone.utc).isoformat()
    current_month = datetime.now(timezone.utc).strftime("%Y-%m")

    try:
        r = supabase.table(_DEV_KEY_TABLE).insert(
            {
                "developer_id": developer_id,
                "key_hash": _hash_key(raw_key),
                "key_prefix": _key_prefix_display(raw_key),
                "plan": "free",
                "status": "active",
                "label": f"[TEST] {body.label[:72]}",
                "calls_used_this_month": 0,
                "month_key": current_month,
                "created_at": now,
            }
        ).execute()
        if not r.data:
            raise ValueError("Insert returned no data")
        inserted = r.data[0]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create test key: {exc}")

    return CreateKeyResponse(
        id=inserted["id"],
        key=raw_key,
        key_prefix=_key_prefix_display(raw_key),
        label=inserted["label"],
        plan="free",
        created_at=inserted["created_at"],
    )


@router.get("", response_model=list[DevKeyMeta])
async def list_developer_keys(auth: dict = Depends(verify_clerk)):
    """List all active developer API keys for the authenticated user (keys masked)."""
    from app.routes.public_api import PLAN_MONTHLY_LIMITS

    supabase = get_supabase()
    if not supabase:
        return []

    developer_id = auth.get("sub")
    if not developer_id:
        raise HTTPException(status_code=401, detail="Missing user id")

    try:
        r = (
            supabase.table(_DEV_KEY_TABLE)
            .select("id, key_prefix, label, plan, status, calls_used_this_month, month_key, created_at, last_used_at")
            .eq("developer_id", developer_id)
            .neq("status", "revoked")
            .order("created_at", desc=True)
            .execute()
        )
        current_month = datetime.now(timezone.utc).strftime("%Y-%m")
        keys = []
        for row in (r.data or []):
            plan = (row.get("plan") or "free").lower()
            used = int(row.get("calls_used_this_month") or 0)
            if row.get("month_key") != current_month:
                used = 0
            limit = PLAN_MONTHLY_LIMITS.get(plan)
            keys.append(
                DevKeyMeta(
                    id=row["id"],
                    key_prefix=row.get("key_prefix") or "sk_live_...",
                    label=row.get("label") or "API Key",
                    plan=plan,
                    status=row.get("status") or "active",
                    calls_used_this_month=used,
                    calls_limit=limit,
                    created_at=row.get("created_at") or "",
                    last_used_at=row.get("last_used_at"),
                )
            )
        return keys
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/{key_id}")
async def revoke_developer_key(key_id: str, auth: dict = Depends(verify_clerk)):
    """Revoke (soft-delete) a developer API key. The developer must own it."""
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    developer_id = auth.get("sub")
    if not developer_id:
        raise HTTPException(status_code=401, detail="Missing user id")

    try:
        r = (
            supabase.table(_DEV_KEY_TABLE)
            .update({"status": "revoked", "updated_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", key_id)
            .eq("developer_id", developer_id)
            .execute()
        )
        if not r.data:
            raise HTTPException(status_code=404, detail="Key not found or already revoked")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return {"revoked": True, "id": key_id}


@router.get("/usage")
async def get_developer_usage(auth: dict = Depends(verify_clerk)):
    """
    Usage statistics for all developer keys.
    Returns per-key breakdown + 30-day daily usage graph.
    """
    from app.routes.public_api import PLAN_MONTHLY_LIMITS

    supabase = get_supabase()
    if not supabase:
        return {"keys": [], "total_calls_this_month": 0, "daily_usage": {}}

    developer_id = auth.get("sub")
    if not developer_id:
        raise HTTPException(status_code=401, detail="Missing user id")

    try:
        keys_r = (
            supabase.table(_DEV_KEY_TABLE)
            .select("id, key_prefix, label, plan, status, calls_used_this_month, month_key")
            .eq("developer_id", developer_id)
            .neq("status", "revoked")
            .execute()
        )
        keys = keys_r.data or []
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    current_month = datetime.now(timezone.utc).strftime("%Y-%m")
    thirty_days_ago = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()

    key_stats = []
    daily_usage: dict[str, int] = {}

    for key in keys:
        key_id = key["id"]
        plan = (key.get("plan") or "free").lower()
        used = int(key.get("calls_used_this_month") or 0)
        if key.get("month_key") != current_month:
            used = 0
        limit = PLAN_MONTHLY_LIMITS.get(plan)

        # Per-endpoint breakdown from usage log
        endpoint_breakdown: dict[str, int] = {}
        total_cost = 0.0
        try:
            log_r = (
                supabase.table(_USAGE_TABLE)
                .select("endpoint, success, calls_cost_usd, timestamp")
                .eq("api_key_id", key_id)
                .gte("timestamp", thirty_days_ago)
                .execute()
            )
            for log in (log_r.data or []):
                if log.get("success"):
                    ep = log.get("endpoint") or "unknown"
                    endpoint_breakdown[ep] = endpoint_breakdown.get(ep, 0) + 1
                    total_cost += float(log.get("calls_cost_usd") or 0)
                # Build daily graph
                ts = log.get("timestamp") or ""
                day = ts[:10]
                if day and log.get("success"):
                    daily_usage[day] = daily_usage.get(day, 0) + 1
        except Exception:
            pass

        key_stats.append(
            {
                "key_id": key_id,
                "key_prefix": key.get("key_prefix") or "sk_live_...",
                "label": key.get("label") or "API Key",
                "plan": plan,
                "status": key.get("status") or "active",
                "calls_used": used,
                "calls_limit": limit,
                "calls_remaining": (limit - used) if limit is not None else None,
                "endpoint_breakdown": endpoint_breakdown,
                "total_cost_usd": round(total_cost, 4),
            }
        )

    return {
        "keys": key_stats,
        "total_calls_this_month": sum(k["calls_used"] for k in key_stats),
        "daily_usage": daily_usage,
    }


@router.post("/subscribe")
async def subscribe_developer_plan(
    body: SubscribeRequest,
    auth: dict = Depends(verify_clerk),
):
    """
    Create a Stripe Checkout Session for a developer API plan.
    Returns { url } — redirect the user to this URL.
    """
    from app.config import get_settings
    from app.routes.billing import _stripe_http_request

    settings = get_settings()

    plan = (body.plan or "").lower()
    if plan not in ("starter", "pro", "enterprise"):
        raise HTTPException(status_code=400, detail="plan must be: starter | pro | enterprise")

    price_attr = _PLAN_PRICE_ENV.get(plan, "")
    price_id = getattr(settings, price_attr, "") or ""
    if not price_id:
        raise HTTPException(
            status_code=503,
            detail=f"Stripe price not configured for developer {plan} plan. "
                   f"Set {price_attr.upper()} in backend .env.",
        )

    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    developer_id = auth.get("sub") or ""
    email = auth.get("email") or auth.get("primary_email_address") or ""

    success_url = (
        (body.success_url or "").strip()
        or f"{settings.frontend_url}/developers/dashboard?billing=success"
    )
    cancel_url = (
        (body.cancel_url or "").strip()
        or f"{settings.frontend_url}/developers?billing=cancel"
    )

    data: dict[str, str] = {
        "mode": "subscription",
        "line_items[0][price]": price_id,
        "line_items[0][quantity]": "1",
        "success_url": success_url,
        "cancel_url": cancel_url,
        "subscription_data[metadata][developer_id]": developer_id,
        "subscription_data[metadata][plan]": plan,
        "subscription_data[metadata][product]": "developer_api",
        "metadata[developer_id]": developer_id,
        "metadata[plan]": plan,
        "metadata[product]": "developer_api",
    }
    if email:
        data["customer_email"] = email

    resp = _stripe_http_request(
        method="POST",
        url="https://api.stripe.com/v1/checkout/sessions",
        stripe_secret_key=settings.stripe_secret_key,
        data=data,
    )
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Stripe error: {resp.text[:200]}")

    body_json = resp.json()
    url = body_json.get("url")
    if not url:
        raise HTTPException(status_code=502, detail="Stripe returned no checkout URL")

    return {"url": url}
