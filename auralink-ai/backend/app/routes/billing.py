"""
Stripe billing: Checkout + webhooks to persist user tier.

Assumes Supabase tables exist:
  - user_billing (clerk_user_id PK, tier, status, stripe_customer_id, stripe_subscription_id, current_period_end, updated_at)
  - user_scan_usage_monthly (clerk_user_id, month_key, scans_used, updated_at): month_key holds YYYY-MM (monthly) or YYYY-MM-DD (daily) per STARTER_SCAN_QUOTA_WINDOW.
"""

from contextlib import contextmanager
import os
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
import httpx

from app.auth import verify_clerk
from app.config import get_settings
from app.db import add_bonus_credits, get_supabase, is_valid_anon_uuid, upsert_user_billing

router = APIRouter()


def _is_local_dev_runtime() -> bool:
    """Allow SSL fallback only for local development hosts."""
    settings = get_settings()
    host = (urlparse(settings.frontend_url).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1"}


def _stripe_http_request(
    *,
    method: str,
    url: str,
    stripe_secret_key: str,
    data: Optional[dict] = None,
    params: Optional[dict] = None,
) -> httpx.Response:
    """
    Stripe request with explicit CA bundle.
    Local dev fallback: if local cert chain is broken, retry once with verify=False.
    """
    verify_target = True
    try:
        import certifi  # type: ignore

        verify_target = certifi.where()
    except Exception:
        verify_target = True

    with _without_proxy_env():
        try:
            with httpx.Client(timeout=30.0, trust_env=False, verify=verify_target) as client:
                return client.request(
                    method,
                    url,
                    headers={"Authorization": f"Bearer {stripe_secret_key}"},
                    data=data,
                    params=params,
                )
        except httpx.HTTPError as e:
            msg = str(e)
            ssl_error = "CERTIFICATE_VERIFY_FAILED" in msg or "certificate verify failed" in msg.lower()
            if ssl_error and _is_local_dev_runtime():
                with httpx.Client(timeout=30.0, trust_env=False, verify=False) as client:  # noqa: S501 (dev-only fallback)
                    return client.request(
                        method,
                        url,
                        headers={"Authorization": f"Bearer {stripe_secret_key}"},
                        data=data,
                        params=params,
                    )
            raise HTTPException(status_code=502, detail=f"Stripe connection error: {msg}") from e


@contextmanager
def _without_proxy_env():
    """
    Stripe calls can fail in local dev when HTTP(S)_PROXY points to a blocked tunnel.
    Temporarily remove proxy env vars for the Stripe request only.
    """
    keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
    original = {k: os.environ.get(k) for k in keys}
    try:
        for k in keys:
            os.environ.pop(k, None)
        yield
    finally:
        for k, v in original.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _get_stripe():
    settings = get_settings()
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")
    import stripe  # type: ignore

    stripe.api_key = settings.stripe_secret_key
    # Force direct egress (no proxy/tunnel) for local/dev environments.
    stripe.proxy = None
    stripe.default_http_client = None
    return stripe


def _tier_to_price_id(tier: str) -> str:
    settings = get_settings()
    tier = (tier or "").strip().lower()
    if tier == "pro":
        return settings.stripe_price_pro
    if tier == "growth":
        return settings.stripe_price_growth
    if tier == "scale":
        return settings.stripe_price_scale
    return ""


def _create_checkout_session_direct(
    *,
    stripe_secret_key: str,
    price_id: str,
    success_url: str,
    cancel_url: str,
    clerk_user_id: str,
    tier: str,
    email: Optional[str],
):
    data = {
        "mode": "subscription",
        "line_items[0][price]": price_id,
        "line_items[0][quantity]": "1",
        "success_url": success_url,
        "cancel_url": cancel_url,
        "subscription_data[metadata][clerk_user_id]": clerk_user_id,
        "subscription_data[metadata][tier]": tier,
        "metadata[clerk_user_id]": clerk_user_id,
        "metadata[tier]": tier,
    }
    if email:
        data["customer_email"] = email

    resp = _stripe_http_request(
        method="POST",
        url="https://api.stripe.com/v1/checkout/sessions",
        stripe_secret_key=stripe_secret_key,
        data=data,
    )
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Stripe error: {resp.text}")
    body = resp.json()
    url = body.get("url")
    if not isinstance(url, str) or not url:
        raise HTTPException(status_code=502, detail="Stripe error: missing checkout URL")
    return url


def _create_portal_session_direct(
    *,
    stripe_secret_key: str,
    customer_id: str,
    return_url: str,
):
    resp = _stripe_http_request(
        method="POST",
        url="https://api.stripe.com/v1/billing_portal/sessions",
        stripe_secret_key=stripe_secret_key,
        data={
            "customer": customer_id,
            "return_url": return_url,
        },
    )
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Stripe error: {resp.text}")
    body = resp.json()
    url = body.get("url")
    if not isinstance(url, str) or not url:
        raise HTTPException(status_code=502, detail="Stripe error: missing portal URL")
    return url


def _fetch_checkout_session_direct(
    *,
    stripe_secret_key: str,
    session_id: str,
) -> dict:
    resp = _stripe_http_request(
        method="GET",
        url=f"https://api.stripe.com/v1/checkout/sessions/{session_id}",
        stripe_secret_key=stripe_secret_key,
        params={"expand[]": "subscription"},
    )
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Stripe error: {resp.text}")
    body = resp.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="Stripe error: invalid checkout session response")
    return body


@router.post("/guest-checkout")
async def create_guest_scan_pack_checkout(payload: dict):
    """
    One-time Stripe Checkout for guest scan credits (no Clerk).
    Body: { anon_id, success_url?, cancel_url? } — anon_id must match X-SyncLyst-Anon-Id on scans.
    """
    settings = get_settings()
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")
    price_id = (settings.stripe_price_scan_pack or "").strip()
    if not price_id:
        raise HTTPException(status_code=503, detail="Scan pack price not configured (STRIPE_PRICE_SCAN_PACK)")
    anon_id = (payload.get("anon_id") or "").strip()
    if not is_valid_anon_uuid(anon_id):
        raise HTTPException(status_code=400, detail="Invalid or missing anon_id (expected UUID)")
    try:
        pack_credits = max(1, min(1_000_000, int(settings.guest_scan_pack_credits)))
    except (TypeError, ValueError):
        pack_credits = 50

    success_url = (payload.get("success_url") or "").strip() or f"{settings.frontend_url}/?scan_credits=success"
    if "session_id=" not in success_url:
        success_url = f"{success_url}{'&' if '?' in success_url else '?'}session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = (payload.get("cancel_url") or "").strip() or f"{settings.frontend_url}/?scan_credits=cancel"

    data = {
        "mode": "payment",
        "line_items[0][price]": price_id,
        "line_items[0][quantity]": "1",
        "success_url": success_url,
        "cancel_url": cancel_url,
        "metadata[guest_anon_id]": anon_id,
        "metadata[credits]": str(pack_credits),
        "metadata[kind]": "guest_scan_pack",
    }

    resp = _stripe_http_request(
        method="POST",
        url="https://api.stripe.com/v1/checkout/sessions",
        stripe_secret_key=settings.stripe_secret_key,
        data=data,
    )
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Stripe error: {resp.text}")
    body = resp.json()
    url = body.get("url")
    if not isinstance(url, str) or not url:
        raise HTTPException(status_code=502, detail="Stripe error: missing checkout URL")
    return {"url": url, "credits": pack_credits}


@router.post("/checkout-session")
async def create_checkout_session(payload: dict, _auth: dict = Depends(verify_clerk)):
    """
    Create Stripe Checkout Session for subscription tier.
    Body: { tier: "pro"|"growth"|"scale", success_url?: str, cancel_url?: str }
    Returns: { url }
    """
    tier = (payload.get("tier") or "").strip().lower()
    if tier not in ("pro", "growth", "scale"):
        raise HTTPException(status_code=400, detail="Invalid tier")
    price_id = _tier_to_price_id(tier)
    if not price_id:
        raise HTTPException(status_code=503, detail="Stripe price not configured for tier")

    settings = get_settings()
    clerk_user_id = _auth.get("sub")
    if not clerk_user_id:
        raise HTTPException(status_code=401, detail="Missing user id")

    # If JWT has email, use it; otherwise Stripe will collect.
    email = _auth.get("email") or _auth.get("primary_email_address") or _auth.get("email_address")

    success_url = (payload.get("success_url") or "").strip() or f"{settings.frontend_url}/dashboard?billing=success"
    # Include session id placeholder so frontend can confirm billing immediately on return.
    if "session_id=" not in success_url:
        success_url = f"{success_url}{'&' if '?' in success_url else '?'}session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = (payload.get("cancel_url") or "").strip() or f"{settings.frontend_url}/dashboard/upgrade?billing=cancel"

    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    url = _create_checkout_session_direct(
        stripe_secret_key=settings.stripe_secret_key,
        price_id=price_id,
        success_url=success_url,
        cancel_url=cancel_url,
        clerk_user_id=clerk_user_id,
        tier=tier,
        email=email if isinstance(email, str) and email else None,
    )
    return {"url": url}


@router.post("/confirm")
async def confirm_checkout_session(payload: dict, _auth: dict = Depends(verify_clerk)):
    """
    Confirm Stripe checkout session and upsert billing immediately after redirect.
    Body: { session_id: "cs_..." }
    Returns: { ok: true, tier, status }
    """
    session_id = (payload.get("session_id") or "").strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="Missing session_id")
    settings = get_settings()
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")
    clerk_user_id = (_auth.get("sub") or "").strip()
    if not clerk_user_id:
        raise HTTPException(status_code=401, detail="Missing user id")
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    session = _fetch_checkout_session_direct(
        stripe_secret_key=settings.stripe_secret_key,
        session_id=session_id,
    )
    metadata = session.get("metadata") or {}
    md_user_id = (metadata.get("clerk_user_id") or "").strip()
    tier = (metadata.get("tier") or "").strip().lower() or "starter"
    payment_status = (session.get("payment_status") or "").strip().lower()
    subscription = session.get("subscription")
    customer_id = session.get("customer")
    subscription_id = subscription.get("id") if isinstance(subscription, dict) else subscription
    sub_status = (subscription.get("status") or "").strip().lower() if isinstance(subscription, dict) else ""
    effective_status = sub_status or ("active" if payment_status in ("paid", "no_payment_required") else "incomplete")

    if md_user_id and md_user_id != clerk_user_id:
        raise HTTPException(status_code=403, detail="Checkout session does not belong to this user")
    if tier not in ("starter", "pro", "growth", "scale"):
        tier = "starter"

    upsert_user_billing(
        supabase,
        clerk_user_id=clerk_user_id,
        tier=tier,
        status=effective_status,
        stripe_customer_id=customer_id if isinstance(customer_id, str) else None,
        stripe_subscription_id=subscription_id if isinstance(subscription_id, str) else None,
    )
    return {"ok": True, "tier": tier, "status": effective_status}


@router.post("/portal")
async def create_portal_session(payload: dict, _auth: dict = Depends(verify_clerk)):
    """Create a Stripe Customer Portal session for the current user."""
    settings = get_settings()
    supabase = get_supabase()
    if not supabase:
        raise HTTPException(status_code=503, detail="Database not configured")

    clerk_user_id = _auth.get("sub")
    if not clerk_user_id:
        raise HTTPException(status_code=401, detail="Missing user id")

    # Load stripe_customer_id from DB
    try:
        r = supabase.table("user_billing").select("stripe_customer_id").eq("clerk_user_id", clerk_user_id).limit(1).execute()
        customer_id = r.data[0]["stripe_customer_id"] if r.data and len(r.data) > 0 else None
    except Exception:
        customer_id = None
    if not customer_id:
        raise HTTPException(status_code=404, detail="No Stripe customer on file")

    return_url = (payload.get("return_url") or "").strip() or settings.stripe_customer_portal_return_url or f"{settings.frontend_url}/dashboard"
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")
    url = _create_portal_session_direct(
        stripe_secret_key=settings.stripe_secret_key,
        customer_id=customer_id,
        return_url=return_url,
    )
    return {"url": url}


@router.post("/webhook")
async def stripe_webhook(request: Request):
    """Stripe webhook to sync subscription status -> user_billing."""
    settings = get_settings()
    if not settings.stripe_webhook_secret:
        raise HTTPException(status_code=503, detail="Stripe webhook secret not configured")

    stripe = _get_stripe()
    sig = request.headers.get("stripe-signature") or request.headers.get("Stripe-Signature")
    raw = await request.body()
    try:
        event = stripe.Webhook.construct_event(payload=raw, sig_header=sig, secret=settings.stripe_webhook_secret)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Stripe signature")

    supabase = get_supabase()
    if not supabase:
        # In dev without DB, just ack so Stripe doesn't retry.
        return {"received": True, "db": False}

    etype = event.get("type")
    obj = event.get("data", {}).get("object", {}) or {}

    def _get_clerk_user_id() -> str:
        md = obj.get("metadata") or {}
        return (md.get("clerk_user_id") or "").strip()

    try:
        if etype == "checkout.session.completed":
            md = obj.get("metadata") or {}
            if (md.get("kind") or "").strip() == "guest_scan_pack":
                guest_anon = (md.get("guest_anon_id") or "").strip()
                if guest_anon and is_valid_anon_uuid(guest_anon):
                    try:
                        n = int(md.get("credits") or settings.guest_scan_pack_credits)
                    except (TypeError, ValueError):
                        n = settings.guest_scan_pack_credits
                    n = max(1, min(1_000_000, int(n)))
                    add_bonus_credits(supabase, f"anon:{guest_anon}", n)
            # Session contains customer + subscription IDs
            clerk_user_id = (md.get("clerk_user_id") or "").strip()
            tier = (md.get("tier") or "").strip().lower() or "starter"
            customer_id = obj.get("customer")
            subscription_id = obj.get("subscription")
            if clerk_user_id:
                upsert_user_billing(
                    supabase,
                    clerk_user_id=clerk_user_id,
                    tier=tier,
                    status="active",
                    stripe_customer_id=customer_id,
                    stripe_subscription_id=subscription_id,
                )

        if etype in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
            md = obj.get("metadata") or {}
            clerk_user_id = (md.get("clerk_user_id") or "").strip()
            tier = (md.get("tier") or "").strip().lower() or "starter"
            status = (obj.get("status") or "").strip().lower() or ("canceled" if etype.endswith("deleted") else "active")
            customer_id = obj.get("customer")
            subscription_id = obj.get("id")
            current_period_end = obj.get("current_period_end")
            if clerk_user_id:
                upsert_user_billing(
                    supabase,
                    clerk_user_id=clerk_user_id,
                    tier=tier,
                    status=status,
                    stripe_customer_id=customer_id,
                    stripe_subscription_id=subscription_id,
                    current_period_end=current_period_end if isinstance(current_period_end, int) else None,
                )
    except Exception:
        # Always ack so Stripe doesn't retry endlessly; you'll see failures in logs.
        return {"received": True, "synced": False}

    return {"received": True}

