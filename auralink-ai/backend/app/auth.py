"""
Clerk JWT verification for protected API routes.
Uses JWKS from Clerk to verify Bearer tokens.
Also accepts permanent `syn_live_` API keys stored in Supabase.
"""
from typing import Optional
import base64
from urllib.parse import urlparse

import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings

_security = HTTPBearer(auto_error=False)
_jwks_client: Optional[jwt.PyJWKClient] = None

_SYN_KEY_PREFIX = "syn_live_"


def _try_api_key_auth(token: str) -> Optional[dict]:
    """
    If the token looks like a Synclyst permanent API key, verify it against Supabase.
    Returns a synthetic claims dict on success, None if not an API key.
    Raises HTTPException 401 if it IS a syn_ key but not found/revoked.
    """
    if not token.startswith(_SYN_KEY_PREFIX):
        return None
    # Import here to avoid circular imports
    from app.db import get_supabase
    from app.routes.api_keys import lookup_api_key
    supabase = get_supabase()
    row = lookup_api_key(supabase, token)
    if not row:
        raise HTTPException(status_code=401, detail="Invalid or revoked API key")
    # Return claims-like dict so callers can use auth.get("sub") as usual
    return {"sub": row["clerk_user_id"], "sid": row["id"], "auth_method": "api_key"}


def _is_local_dev_runtime() -> bool:
    """Allow auth fallback only for localhost-based development."""
    settings = get_settings()
    if not getattr(settings, "allow_local_dev_auth_fallback", False):
        return False
    host = (urlparse(settings.frontend_url).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1"}


def _derive_clerk_jwks_url_from_publishable_key(publishable_key: str) -> Optional[str]:
    """
    Derive Clerk instance JWKS URL from publishable key.
    Example key payload decodes to: "<instance>.clerk.accounts.dev$".
    """
    key = (publishable_key or "").strip()
    if not key:
        return None
    parts = key.split("_", 2)
    if len(parts) < 3:
        return None
    encoded = parts[-1]
    # Clerk key payload is base64 (often URL-safe) and may be unpadded.
    pad = "=" * ((4 - (len(encoded) % 4)) % 4)
    try:
        decoded = base64.urlsafe_b64decode((encoded + pad).encode("utf-8")).decode("utf-8")
    except Exception:
        return None
    host = decoded.rstrip("$").strip()
    if not host or "." not in host:
        return None
    return f"https://{host}/.well-known/jwks.json"


def _get_jwks_client() -> jwt.PyJWKClient:
    """Get or create PyJWKClient for Clerk JWKS."""
    global _jwks_client
    if _jwks_client is not None:
        return _jwks_client
    settings = get_settings()
    configured = (getattr(settings, "clerk_jwks_url", None) or "").strip()
    default_jwks = "https://api.clerk.com/v1/jwks"
    derived = _derive_clerk_jwks_url_from_publishable_key(
        getattr(settings, "clerk_publishable_key", "") or ""
    )
    # Prefer instance-specific JWKS when config is blank or just the global default.
    if configured and configured != default_jwks:
        jwks_url = configured
    else:
        jwks_url = derived or configured or default_jwks
    _jwks_client = jwt.PyJWKClient(jwks_url)
    return _jwks_client


async def verify_clerk(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_security),
) -> dict:
    """
    Verify auth from Authorization: Bearer <token>.
    Accepts:
      - Synclyst permanent API keys (syn_live_...)
      - Clerk JWTs
    Returns decoded claims or raises 401.
    When Clerk is not configured, allows all requests (dev mode).
    """
    settings = get_settings()
    if not settings.clerk_secret_key:
        return {"sub": "dev", "sid": "dev"}
    token = credentials.credentials if credentials else None
    if not token:
        if _is_local_dev_runtime():
            return {"sub": "dev-local-user", "sid": "dev-local-session"}
        raise HTTPException(status_code=401, detail="Missing or invalid authorization")

    # Try permanent API key first (fast path — no network call)
    api_key_claims = _try_api_key_auth(token)
    if api_key_claims is not None:
        return api_key_claims

    # Fall back to Clerk JWT verification
    try:
        jwks = _get_jwks_client()
        signing_key = jwks.get_signing_key_from_jwt(token)
        decoded = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={"verify_exp": True, "verify_nbf": True},
        )
        return decoded
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        if _is_local_dev_runtime():
            return {"sub": "dev-local-user", "sid": "dev-local-session"}
        raise HTTPException(status_code=401, detail="Invalid token")
    except Exception as e:
        if _is_local_dev_runtime():
            return {"sub": "dev-local-user", "sid": "dev-local-session"}
        raise HTTPException(status_code=401, detail=str(e))


async def optional_verify_clerk(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_security),
) -> Optional[dict]:
    """
    Optional auth: when token present, verify (raise 401 if invalid); when absent, return None.
    Use for routes that work for both anonymous and authenticated (e.g. landing save-as-draft).
    Accepts both syn_live_ API keys and Clerk JWTs.
    """
    settings = get_settings()
    if not settings.clerk_secret_key:
        return {"sub": "dev", "sid": "dev"}
    token = credentials.credentials if credentials else None
    if not token:
        return None

    # Try permanent API key first
    api_key_claims = _try_api_key_auth(token)
    if api_key_claims is not None:
        return api_key_claims

    try:
        jwks = _get_jwks_client()
        signing_key = jwks.get_signing_key_from_jwt(token)
        decoded = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={"verify_exp": True, "verify_nbf": True},
        )
        return decoded
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))
