"""
User usage: tier + scan quota for paywall flow.
"""
from fastapi import APIRouter, Depends, HTTPException
from starlette.requests import Request

from app.auth import verify_clerk
from app.config import get_settings
from app.db import (
    get_supabase,
    get_scan_usage,
    get_scan_usage_unified,
    is_valid_anon_uuid,
    starter_monthly_limit,
    get_ip_scan_count,
)

router = APIRouter()


@router.get("", response_model=dict)
async def get_usage(_auth: dict = Depends(verify_clerk)):
    """
    Return current user's scan usage: tier, scans_used, scans_limit, can_scan.
    Used by dashboard and to show paywall when can_scan is false.
    """
    supabase = get_supabase()
    if not supabase:
        lim = starter_monthly_limit()
        qw = (get_settings().starter_scan_quota_window or "daily").strip().lower()
        return {
            "tier": "starter",
            "scans_used": 0,
            "scans_limit": lim,
            "can_scan": True,
            "demo": True,
            "quota_window": qw if qw in ("daily", "monthly") else "daily",
        }
    user_id = _auth.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Missing user id")
    return get_scan_usage(supabase, user_id)


def _get_guest_ip(request: Request) -> str:
    forwarded = (
        request.headers.get("x-forwarded-for") or
        request.headers.get("X-Forwarded-For") or ""
    ).strip()
    if forwarded:
        return forwarded.split(",")[0].strip()
    return (request.client.host if request.client else "unknown") or "unknown"


@router.get("/guest", response_model=dict)
async def get_usage_guest(request: Request):
    """
    Guest device usage (X-SyncLyst-Anon-Id): free daily scans + bonus credits from Stripe pack.
    Returns the effective remaining scans — the lower of anon-bucket and IP-bucket.
    """
    raw = (request.headers.get("X-SyncLyst-Anon-Id") or request.headers.get("x-synclyst-anon-id") or "").strip()
    if not is_valid_anon_uuid(raw):
        raise HTTPException(status_code=400, detail="Missing or invalid X-SyncLyst-Anon-Id header")
    supabase = get_supabase()
    if not supabase:
        lim = starter_monthly_limit()
        qw = (get_settings().starter_scan_quota_window or "daily").strip().lower()
        return {
            "tier": "guest",
            "scans_used": 0,
            "scans_limit": lim,
            "bonus_credits": 0,
            "can_scan": True,
            "demo": True,
            "quota_window": qw if qw in ("daily", "monthly") else "daily",
        }
    result = get_scan_usage_unified(supabase, f"anon:{raw}")
    # Factor in the IP-based count so the UI shows the correct remaining number
    # regardless of which browser the user is on.
    bonus = int(result.get("bonus_credits") or 0)
    if bonus == 0:
        client_ip = _get_guest_ip(request)
        ip_count = get_ip_scan_count(supabase, client_ip)
        daily_limit = starter_monthly_limit()
        # Effective used = whichever counter is higher
        effective_used = max(int(result.get("scans_used") or 0), ip_count)
        result = {
            **result,
            "scans_used": effective_used,
            "can_scan": effective_used < daily_limit,
        }
    return result
