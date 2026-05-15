"""
User usage: tier + scan quota for paywall flow.
"""
from fastapi import APIRouter, Depends, HTTPException
from starlette.requests import Request

from app.auth import verify_clerk
from app.config import get_settings
from app.db import get_supabase, get_scan_usage, get_scan_usage_unified, is_valid_anon_uuid, starter_monthly_limit

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


@router.get("/guest", response_model=dict)
async def get_usage_guest(request: Request):
    """
    Guest device usage (X-SyncLyst-Anon-Id): free daily scans + bonus credits from Stripe pack.
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
    return get_scan_usage_unified(supabase, f"anon:{raw}")
