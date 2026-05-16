"""Application configuration from environment."""
from pathlib import Path

from pydantic_settings import BaseSettings
from pydantic import field_validator
from functools import lru_cache
from typing import List

# Load .env from backend directory so it works regardless of cwd
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_ENV_FILE = _BACKEND_DIR / ".env"


class Settings(BaseSettings):
    """Settings loaded from env (e.g. .env)."""

    # API
    app_name: str = "SyncLyst"
    debug: bool = False

    # CORS: comma-separated list of allowed origins (e.g. https://app.example.com,https://www.example.com)
    # If empty, defaults to ["*"] for development. Set in production for security.
    cors_origins: str = ""

    # Vision: one of "gemini" | "openai"
    vision_provider: str = "gemini"
    gemini_api_key: str = ""
    openai_api_key: str = ""
    # Force dummy extraction even if keys exist (local dev safety switch).
    force_dummy_vision: bool = False

    # Web enrichment: after image extraction, use Gemini + Google Search to fetch exact
    # product name and full listing details from the web (optional; requires Gemini key).
    enable_web_enrichment: bool = True
    # Second stage: fetch HTTPS product pages and extract JSON-LD / OG text (more accurate than
    # model-paraphrased blurbs). SSRF-safe; can be disabled for minimal latency.
    enable_web_page_fetch: bool = True
    web_page_fetch_timeout_sec: float = 12.0
    web_page_fetch_max_bytes: int = 2_000_000

    @field_validator("starter_scan_quota_window", mode="before")
    @classmethod
    def normalize_starter_quota_window(cls, v):
        s = str(v or "daily").strip().lower()
        return s if s in ("daily", "monthly") else "daily"

    @field_validator("gemini_api_key", "openai_api_key", "ebay_app_id", "upcitemdb_user_key", mode="before")
    @classmethod
    def strip_api_key(cls, v):
        if isinstance(v, str):
            return v.strip()
        return v or ""

    # OCR (Google Cloud Vision for label text)
    gcp_vision_credentials_json: str = ""

    # Database (Supabase)
    supabase_url: str = ""
    supabase_service_key: str = ""

    # Redis (for Celery)
    redis_url: str = "redis://localhost:6379/0"

    # Clerk (JWT verification)
    clerk_publishable_key: str = ""
    clerk_secret_key: str = ""
    clerk_jwks_url: str = "https://api.clerk.com/v1/jwks"  # Override if needed
    # Local dev only: when true and frontend_url host is localhost, allow a dev-user auth fallback.
    allow_local_dev_auth_fallback: bool = False

    # Shopify OAuth (Partner Dashboard app credentials)
    shopify_client_id: str = ""
    shopify_client_secret: str = ""
    app_base_url: str = "http://localhost:8000"  # Backend URL for OAuth redirect_uri
    frontend_url: str = "http://localhost:3000"  # Redirect after OAuth success

    # Optional: known brands DB (path or URL) for logo → brand mapping
    brands_db_path: str = ""

    # Integrations: webhook secret for listing-published (optional)
    integrations_webhook_secret: str = ""

    # Starter tier: free product scans before 402 — cap is per STARTER_SCAN_QUOTA_WINDOW ("daily" or "monthly").
    # Defaults: 10/day. Set STARTER_SCAN_QUOTA_WINDOW=monthly and STARTER_SCAN_LIMIT=3 for legacy monthly behavior.
    starter_scan_limit: int = 10
    starter_scan_quota_window: str = "daily"

    # eBay API credentials.
    # EBAY_APP_ID  = Production App ID (Client ID) from developer.ebay.com/my/keys
    # EBAY_CERT_ID = Production Cert ID (Client Secret) — used to auto-fetch OAuth tokens for Browse API
    ebay_app_id: str = ""
    ebay_cert_id: str = ""

    # Barcode lookup (optional): UPCitemdb. If UP CITEMDB_USER_KEY is unset, backend uses the trial endpoint (rate limited).
    upcitemdb_user_key: str = ""
    upcitemdb_key_type: str = "user_key"

    # Profit estimation defaults (fast heuristics; override per scan if needed)
    reseller_fee_rate: float = 0.13
    reseller_payment_rate: float = 0.029
    reseller_payment_fixed: float = 0.30
    reseller_shipping_default: float = 8.0

    # Stripe billing
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_pro: str = ""
    stripe_price_growth: str = ""
    stripe_price_scale: str = ""
    # One-time Stripe Price ID for guest scan pack (payment mode). Webhook adds credits to anonymous_scan_credits.
    stripe_price_scan_pack: str = ""
    # Credits granted per successful scan-pack purchase (default 20).
    guest_scan_pack_credits: int = 20
    stripe_customer_portal_return_url: str = ""

    def get_cors_origins_list(self) -> List[str]:
        """Return CORS origins as a list. Empty or '*' means allow all origins.
        Note: main.py sets allow_credentials=False when this is ['*'] (browser requirement)."""
        local_origins = [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ]
        if not self.cors_origins or self.cors_origins.strip() == "*":
            return ["*"]
        origins = [o.strip() for o in self.cors_origins.split(",") if o.strip()]
        for o in local_origins:
            if o not in origins:
                origins.append(o)
        return origins

    class Config:
        env_file = str(_ENV_FILE) if _ENV_FILE.exists() else ".env"
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()
