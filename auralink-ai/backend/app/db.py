"""
Supabase/PostgreSQL: Universal_Products and Channel_Adapters.
"""
import os
import re
from urllib.parse import urlparse
from typing import Optional, Any
from uuid import uuid4

from app.config import get_settings
from app.schemas.product import UniversalProductCreate


_supabase_client: Optional[Any] = None


def get_supabase():
    """Return Supabase client or None if not configured."""
    global _supabase_client
    if _supabase_client is not None:
        return _supabase_client
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_key:
        return None
    try:
        # Some local environments inject HTTPS proxy vars that break Supabase API calls.
        # Keep other proxy behavior intact while explicitly bypassing proxy for Supabase host.
        host = urlparse(settings.supabase_url).hostname or ""
        if host:
            existing = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
            parts = [p.strip() for p in existing.split(",") if p.strip()]
            if host not in parts:
                parts.append(host)
            if ".supabase.co" not in parts:
                parts.append(".supabase.co")
            no_proxy_value = ",".join(parts)
            os.environ["NO_PROXY"] = no_proxy_value
            os.environ["no_proxy"] = no_proxy_value
        from supabase import create_client
        _supabase_client = create_client(
            settings.supabase_url,
            settings.supabase_service_key,
        )
        return _supabase_client
    except Exception:
        return None


def create_product(supabase, payload: UniversalProductCreate) -> dict:
    """Insert into universal_products; return inserted row."""
    row = {
        "id": str(uuid4()),
        "attributes_material": payload.attributes_material,
        "attributes_color": payload.attributes_color,
        "attributes_weight": payload.attributes_weight,
        "attributes_dimensions": payload.attributes_dimensions,
        "attributes_brand": payload.attributes_brand,
        "copy_seo_title": payload.copy_seo_title,
        "copy_description": payload.copy_description,
        "copy_bullet_points": payload.copy_bullet_points,
        "tags_category": payload.tags_category,
        "tags_search_keywords": payload.tags_search_keywords,
        "image_url": payload.image_url,
        "image_urls": payload.image_urls or [],
        "status": payload.status,
        "source_image_id": payload.source_image_id,
    }
    if payload.exact_model is not None:
        row["exact_model"] = payload.exact_model
    if payload.material_composition is not None:
        row["material_composition"] = payload.material_composition
    if payload.weight_grams is not None:
        row["weight_grams"] = payload.weight_grams
    if payload.condition_score is not None:
        row["condition_score"] = payload.condition_score
    r = supabase.table("universal_products").insert(row).execute()
    if not r.data or len(r.data) == 0:
        raise ValueError("Insert failed")
    return r.data[0]


def get_product(supabase, product_id: str) -> Optional[dict]:
    """Get product by id; join channel_adapters if table exists."""
    r = supabase.table("universal_products").select("*").eq("id", product_id).execute()
    if not r.data or len(r.data) == 0:
        return None
    row = r.data[0]
    # Load channel adapters
    try:
        ar = supabase.table("channel_adapters").select("*").eq("product_id", product_id).execute()
        row["channel_adapters"] = ar.data or []
    except Exception:
        row["channel_adapters"] = []
    return row


def list_products(supabase, limit: int = 50, offset: int = 0) -> list:
    """List products ordered by created_at desc."""
    r = (
        supabase.table("universal_products")
        .select("*")
        .order("created_at", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    return r.data or []


def update_product_status(supabase, product_id: str, status: str) -> Optional[dict]:
    """Update product status (e.g. DRAFT -> PUBLISHED). Returns updated row or None."""
    try:
        from datetime import datetime
        r = (
            supabase.table("universal_products")
            .update({"status": status, "updated_at": datetime.utcnow().isoformat()})
            .eq("id", product_id)
            .execute()
        )
        if r.data and len(r.data) > 0:
            return r.data[0]
    except Exception:
        pass
    return None


def get_shopify_store(supabase, shop_domain: str) -> Optional[dict]:
    """Get Shopify store credentials by domain."""
    r = supabase.table("shopify_stores").select("*").eq("shop_domain", shop_domain).execute()
    if not r.data or len(r.data) == 0:
        return None
    return r.data[0]


def upsert_shopify_store(supabase, shop_domain: str, access_token: str, scope: str = "") -> dict:
    """Insert or update Shopify store credentials."""
    from datetime import datetime
    row = {
        "shop_domain": shop_domain,
        "access_token": access_token,
        "scope": scope,
        "updated_at": datetime.utcnow().isoformat(),
    }
    r = supabase.table("shopify_stores").upsert(
        row, on_conflict="shop_domain", update_columns=["access_token", "scope", "updated_at"]
    ).execute()
    if not r.data or len(r.data) == 0:
        raise ValueError("Upsert failed")
    return r.data[0]


def upsert_channel_adapter(supabase, product_id: str, channel: str, external_id: str) -> dict:
    """Insert or update channel adapter (e.g. Shopify GID)."""
    from datetime import datetime
    row = {
        "product_id": product_id,
        "channel": channel,
        "external_id": external_id,
        "synced_at": datetime.utcnow().isoformat(),
    }
    r = supabase.table("channel_adapters").upsert(
        row, on_conflict="product_id,channel", update_columns=["external_id", "synced_at"]
    ).execute()
    if not r.data or len(r.data) == 0:
        raise ValueError("Upsert failed")
    return r.data[0]


def list_shopify_stores(supabase) -> list:
    """List all connected Shopify stores (for feedback worker)."""
    try:
        r = supabase.table("shopify_stores").select("shop_domain, access_token, refresh_token, token_expires_at").execute()
        return r.data or []
    except Exception:
        try:
            r = supabase.table("shopify_stores").select("shop_domain, access_token").execute()
            return r.data or []
        except Exception:
            return []


def get_valid_shopify_access_token(supabase, shop_domain: str) -> tuple[Optional[str], Optional[str]]:
    """
    Return (access_token, None) or (None, error_message). Uses stored token; refreshes if
    token_expires_at is in the past and refresh_token is set. Shopify offline tokens are long-lived.
    """
    try:
        r = supabase.table("shopify_stores").select(
            "access_token, refresh_token, token_expires_at"
        ).eq("shop_domain", shop_domain).limit(1).execute()
    except Exception:
        return None, "Database error"
    if not r.data or len(r.data) == 0:
        return None, "Store not connected"
    row = r.data[0]
    access_token = row.get("access_token")
    refresh_token = row.get("refresh_token")
    expires_at = row.get("token_expires_at")
    if not access_token:
        return None, "No access token"
    if refresh_token and expires_at:
        try:
            from datetime import datetime, timezone
            if hasattr(expires_at, "timestamp"):
                exp = expires_at
            else:
                exp = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if exp <= datetime.now(timezone.utc):
                new_token = _refresh_shopify_token(supabase, shop_domain, refresh_token)
                if new_token:
                    return new_token, None
        except Exception:
            pass
    return access_token, None


def _refresh_shopify_token(supabase, shop_domain: str, refresh_token: str) -> Optional[str]:
    """Refresh Shopify access token when refresh_token is set (e.g. online token flow). Returns new access_token or None."""
    settings = get_settings()
    if not settings.shopify_client_id or not settings.shopify_client_secret:
        return None
    import httpx
    from datetime import datetime, timezone, timedelta
    url = f"https://{shop_domain}/admin/oauth/access_token"
    try:
        with httpx.Client(timeout=15.0) as client:
            r = client.post(
                url,
                data={
                    "client_id": settings.shopify_client_id,
                    "client_secret": settings.shopify_client_secret,
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        if r.status_code != 200:
            return None
        data = r.json()
        new_token = data.get("access_token")
        expires_in = data.get("expires_in")
        if not new_token:
            return None
        updated = {"access_token": new_token, "updated_at": datetime.now(timezone.utc).isoformat()}
        if expires_in is not None:
            updated["token_expires_at"] = (datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))).isoformat()
        supabase.table("shopify_stores").update(updated).eq("shop_domain", shop_domain).execute()
        return new_token
    except Exception:
        return None


def get_channel_adapter_by_external_id(supabase, channel: str, external_id: str) -> Optional[dict]:
    """Get channel adapter by channel and external_id (e.g. Shopify GID). Returns row with product_id."""
    try:
        r = (
            supabase.table("channel_adapters")
            .select("product_id, external_id")
            .eq("channel", channel)
            .eq("external_id", external_id)
            .limit(1)
            .execute()
        )
        if r.data and len(r.data) > 0:
            return r.data[0]
    except Exception:
        pass
    return None


def get_channel_push_snapshot(supabase, product_id: str, channel: str) -> Optional[dict]:
    """Get the latest channel_push_snapshot for this product and channel (variation_type, ai_prompt_version)."""
    try:
        r = (
            supabase.table("channel_push_snapshots")
            .select("variation_type, ai_prompt_version")
            .eq("product_id", product_id)
            .eq("channel", channel)
            .order("pushed_at", desc=True)
            .limit(1)
            .execute()
        )
        if r.data and len(r.data) > 0:
            return r.data[0]
    except Exception:
        pass
    return None


def upsert_performance_log(
    supabase,
    product_id: str,
    variation_type: str,
    ai_prompt_version: str,
    period_start: str,
    period_end: str,
    *,
    click_count: int = 0,
    orders_count: int = 0,
    revenue_cents: int = 0,
    conversion_rate: float = 0.0,
) -> dict:
    """Insert or update a performance_logs row (unique on product_id, variation_type, ai_prompt_version, period_start, period_end)."""
    from datetime import datetime
    now = datetime.utcnow().isoformat()
    row = {
        "product_id": product_id,
        "variation_type": variation_type,
        "ai_prompt_version": ai_prompt_version,
        "period_start": period_start,
        "period_end": period_end,
        "click_count": click_count,
        "orders_count": orders_count,
        "revenue_cents": revenue_cents,
        "conversion_rate": conversion_rate,
        "updated_at": now,
    }
    try:
        r = supabase.table("performance_logs").upsert(
            row,
            on_conflict="product_id,variation_type,ai_prompt_version,period_start,period_end",
            update_columns=["click_count", "orders_count", "revenue_cents", "conversion_rate", "updated_at"],
        ).execute()
        if r.data and len(r.data) > 0:
            return r.data[0]
    except Exception:
        # Fallback: try insert (ignore if unique violation)
        try:
            row["created_at"] = now
            r = supabase.table("performance_logs").insert(row).execute()
            if r.data and len(r.data) > 0:
                return r.data[0]
        except Exception:
            pass
    return row


def insert_channel_push_snapshot(
    supabase,
    product_id: str,
    channel: str,
    external_id: str,
    variation_type: str,
    ai_prompt_version: str,
    description_variation_id: Optional[str] = None,
) -> dict:
    """Record which variation was pushed to a channel (for feedback correlation)."""
    row = {
        "product_id": product_id,
        "channel": channel,
        "external_id": external_id,
        "variation_type": variation_type,
        "ai_prompt_version": ai_prompt_version,
    }
    if description_variation_id:
        row["description_variation_id"] = description_variation_id
    r = supabase.table("channel_push_snapshots").insert(row).execute()
    if not r.data or len(r.data) == 0:
        raise ValueError("Insert channel_push_snapshot failed")
    return r.data[0]


def get_ucp_manifest(supabase, product_id: str) -> Optional[dict]:
    """Get stored UCP manifest for a product (manifest_json + updated_at)."""
    try:
        r = supabase.table("ucp_manifests").select("*").eq("product_id", product_id).limit(1).execute()
        if r.data and len(r.data) > 0:
            return r.data[0]
    except Exception:
        pass
    return None


def upsert_ucp_manifest(supabase, product_id: str, manifest_json: dict) -> dict:
    """Insert or update ucp_manifests row for this product (one manifest per listing)."""
    from datetime import datetime
    now = datetime.utcnow().isoformat()
    row = {
        "product_id": product_id,
        "manifest_json": manifest_json,
        "updated_at": now,
    }
    try:
        r = supabase.table("ucp_manifests").upsert(
            row,
            on_conflict="product_id",
            update_columns=["manifest_json", "updated_at"],
        ).execute()
        if r.data and len(r.data) > 0:
            return r.data[0]
    except Exception:
        try:
            r = supabase.table("ucp_manifests").insert(row).execute()
            if r.data and len(r.data) > 0:
                return r.data[0]
        except Exception:
            pass
    return row


def get_description_variation(supabase, product_id: str, variation_type: str = "SHOPIFY_META") -> Optional[dict]:
    """Get description_variation for product (for copy_fact_feel_proof GEO)."""
    try:
        r = (
            supabase.table("description_variations")
            .select("*")
            .eq("product_id", product_id)
            .eq("variation_type", variation_type)
            .limit(1)
            .execute()
        )
        if r.data and len(r.data) > 0:
            return r.data[0]
    except Exception:
        pass
    return None


def upsert_description_variation(
    supabase,
    product_id: str,
    variation_type: str,
    copy_seo_title: str,
    copy_description: str,
    copy_bullet_points: Optional[list] = None,
    copy_fact_feel_proof: Optional[dict] = None,
    ai_prompt_version_id: Optional[str] = None,
) -> dict:
    """Insert or update a description_variation (e.g. SHOPIFY_META with Fact-Feel-Proof)."""
    from datetime import datetime
    row = {
        "product_id": product_id,
        "variation_type": variation_type,
        "copy_seo_title": copy_seo_title,
        "copy_description": copy_description,
        "copy_bullet_points": copy_bullet_points if copy_bullet_points is not None else [],
        "copy_fact_feel_proof": copy_fact_feel_proof,
    }
    if ai_prompt_version_id:
        row["ai_prompt_version_id"] = ai_prompt_version_id
    try:
        r = supabase.table("description_variations").upsert(
            row,
            on_conflict="product_id,variation_type",
            update_columns=["copy_seo_title", "copy_description", "copy_bullet_points", "copy_fact_feel_proof", "ai_prompt_version_id"],
        ).execute()
        if r.data and len(r.data) > 0:
            return r.data[0]
    except Exception:
        pass
    r = supabase.table("description_variations").insert(row).execute()
    if not r.data or len(r.data) == 0:
        raise ValueError("Insert description_variation failed")
    return r.data[0]


# ---------------------------------------------------------------------------
# Tier + monthly scan quota (Stripe-backed)
# ---------------------------------------------------------------------------

TIER_LIMITS = {
    "starter": 3,
    "pro": 100,
    "growth": 500,
    "scale": 10**9,  # treat as unlimited
}


def starter_monthly_limit() -> int:
    """Effective starter scan cap (STARTER_SCAN_LIMIT) per STARTER_SCAN_QUOTA_WINDOW bucket; clamped for safety."""
    from app.config import get_settings

    try:
        n = int(get_settings().starter_scan_limit)
    except (TypeError, ValueError):
        n = TIER_LIMITS["starter"]
    return max(1, min(10_000, n))


def _quota_period_key() -> str:
    """Bucket label for streak scan counts: daily (YYYY-MM-DD) or monthly (YYYY-MM UTC), matching starter_scan_quota_window."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    w = (get_settings().starter_scan_quota_window or "daily").strip().lower()
    if w == "daily":
        return f"{now.year:04d}-{now.month:02d}-{now.day:02d}"
    return f"{now.year:04d}-{now.month:02d}"


def get_user_tier(supabase, clerk_user_id: str) -> str:
    """Return user's tier (starter/pro/growth/scale). Defaults to starter."""
    try:
        r = (
            supabase.table("user_billing")
            .select("tier,status")
            .eq("clerk_user_id", clerk_user_id)
            .limit(1)
            .execute()
        )
        if r.data and len(r.data) > 0:
            row = r.data[0] or {}
            tier = (row.get("tier") or "starter").strip().lower()
            status = (row.get("status") or "").strip().lower()
            if status in ("active", "trialing") and tier in TIER_LIMITS:
                return tier
            # If cancelled/past_due/etc. fall back to starter
    except Exception:
        pass
    return "starter"


def upsert_user_billing(
    supabase,
    *,
    clerk_user_id: str,
    tier: str,
    status: str,
    stripe_customer_id: Optional[str] = None,
    stripe_subscription_id: Optional[str] = None,
    current_period_end: Optional[int] = None,
) -> None:
    """Upsert billing state into user_billing (Supabase)."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    row: dict[str, Any] = {
        "clerk_user_id": clerk_user_id,
        "tier": tier,
        "status": status,
        "updated_at": now,
    }
    if stripe_customer_id:
        row["stripe_customer_id"] = stripe_customer_id
    if stripe_subscription_id:
        row["stripe_subscription_id"] = stripe_subscription_id
    if current_period_end is not None:
        row["current_period_end"] = current_period_end
    try:
        supabase.table("user_billing").upsert(
            row,
            on_conflict="clerk_user_id",
            update_columns=["tier", "status", "stripe_customer_id", "stripe_subscription_id", "current_period_end", "updated_at"],
        ).execute()
    except Exception:
        # Table might not exist in dev; fail open.
        return


def get_scan_usage(supabase, clerk_user_id: str) -> dict:
    """Return { tier, scans_used, scans_limit, can_scan, quota_window } for the user (daily or monthly bucket)."""
    tier = get_user_tier(supabase, clerk_user_id) if supabase else "starter"
    if tier == "starter":
        limit = starter_monthly_limit()
    else:
        limit = TIER_LIMITS.get(tier, TIER_LIMITS["starter"])
    used = 0
    try:
        r = (
            supabase.table("user_scan_usage_monthly")
            .select("scans_used")
            .eq("clerk_user_id", clerk_user_id)
            .eq("month_key", _quota_period_key())
            .limit(1)
            .execute()
        )
        used = r.data[0]["scans_used"] if r.data and len(r.data) > 0 else 0
    except Exception:
        used = 0
    qwin = (get_settings().starter_scan_quota_window or "daily").strip().lower()
    if qwin not in ("daily", "monthly"):
        qwin = "daily"
    return {
        "tier": tier,
        "scans_used": used,
        "scans_limit": limit,
        "can_scan": used < limit,
        "quota_window": qwin,
    }


def increment_scan(supabase, clerk_user_id: str) -> dict:
    """Increment scans_used for the current quota bucket; upsert row if missing."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    key = _quota_period_key()
    try:
        r = (
            supabase.table("user_scan_usage_monthly")
            .select("scans_used")
            .eq("clerk_user_id", clerk_user_id)
            .eq("month_key", key)
            .limit(1)
            .execute()
        )
        if r.data and len(r.data) > 0:
            new_count = (r.data[0].get("scans_used") or 0) + 1
            supabase.table("user_scan_usage_monthly").update({"scans_used": new_count, "updated_at": now}).eq(
                "clerk_user_id", clerk_user_id
            ).eq("month_key", key).execute()
        else:
            supabase.table("user_scan_usage_monthly").insert(
                {"clerk_user_id": clerk_user_id, "month_key": key, "scans_used": 1, "updated_at": now}
            ).execute()
            new_count = 1
    except Exception:
        # Table missing or DB error; fail open but return safe-ish values
        new_count = 0
    usage = get_scan_usage(supabase, clerk_user_id)
    usage["scans_used"] = max(usage.get("scans_used", 0), new_count)
    usage["can_scan"] = usage["scans_used"] < usage["scans_limit"]
    return usage


_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.I,
)


def is_valid_anon_uuid(value: Optional[str]) -> bool:
    return bool(value and _UUID_RE.match(str(value).strip()))


def get_bonus_credits(supabase, quota_key: str) -> int:
    if not supabase or not quota_key.startswith("anon:"):
        return 0
    aid = quota_key[5:]
    try:
        r = supabase.table("anonymous_scan_credits").select("credits").eq("anon_id", aid).limit(1).execute()
        if r.data and len(r.data) > 0:
            return int(r.data[0].get("credits") or 0)
    except Exception:
        pass
    return 0


def add_bonus_credits(supabase, quota_key: str, delta: int) -> int:
    from datetime import datetime, timezone

    if not supabase or not quota_key.startswith("anon:"):
        return 0
    aid = quota_key[5:]
    now = datetime.now(timezone.utc).isoformat()
    cur = get_bonus_credits(supabase, quota_key)
    new_val = max(0, cur + int(delta))
    try:
        supabase.table("anonymous_scan_credits").upsert(
            {"anon_id": aid, "credits": new_val, "updated_at": now},
            on_conflict="anon_id",
        ).execute()
    except Exception:
        pass
    return new_val


def get_scan_usage_unified(supabase, quota_key: Optional[str]) -> dict:
    """Starter limits + optional purchased credits for guest anon:* keys."""
    qwin = (get_settings().starter_scan_quota_window or "daily").strip().lower()
    if qwin not in ("daily", "monthly"):
        qwin = "daily"
    if not quota_key or not supabase:
        return {
            "tier": "starter",
            "scans_used": 0,
            "scans_limit": starter_monthly_limit(),
            "bonus_credits": 0,
            "can_scan": True,
            "quota_window": qwin,
        }
    if quota_key.startswith("anon:"):
        base = get_scan_usage(supabase, quota_key)
        bonus = get_bonus_credits(supabase, quota_key)
        used = int(base.get("scans_used") or 0)
        lim = int(base.get("scans_limit") or starter_monthly_limit())
        can = (used < lim) or (bonus > 0)
        return {
            **base,
            "bonus_credits": bonus,
            "can_scan": can,
            "quota_window": base.get("quota_window") or qwin,
        }
    base = get_scan_usage(supabase, quota_key)
    base["bonus_credits"] = 0
    return base


def consume_one_scan(supabase, quota_key: str) -> None:
    if not supabase or not quota_key:
        return
    u = get_scan_usage_unified(supabase, quota_key)
    if not u.get("can_scan", True):
        return
    used = int(u.get("scans_used") or 0)
    lim = int(u.get("scans_limit") or starter_monthly_limit())
    bonus = int(u.get("bonus_credits") or 0)
    if used < lim:
        increment_scan(supabase, quota_key)
        return
    if quota_key.startswith("anon:") and bonus > 0:
        add_bonus_credits(supabase, quota_key, -1)

