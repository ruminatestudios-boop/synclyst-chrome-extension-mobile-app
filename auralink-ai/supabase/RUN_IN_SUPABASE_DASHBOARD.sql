-- =============================================================================
-- SyncLyst / AuraLink AI — Consolidated migration
-- Run this ONCE in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/jjqwcgbpwapamulsgekk/sql/new
-- All statements are idempotent (safe to re-run).
-- =============================================================================

-- Needed for gen_random_uuid() on some Postgres versions.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. Universal Products (master product profile, channel-agnostic)
-- =============================================================================
CREATE TABLE IF NOT EXISTS universal_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attributes_material TEXT,
  attributes_color TEXT,
  attributes_weight TEXT,
  attributes_dimensions TEXT,
  attributes_brand TEXT,
  copy_seo_title TEXT NOT NULL,
  copy_description TEXT NOT NULL,
  copy_bullet_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags_category TEXT,
  tags_search_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_url TEXT,
  image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'PUBLISHED')),
  source_image_id TEXT
);

-- Runtime alignment columns (added in later migrations)
ALTER TABLE universal_products ADD COLUMN IF NOT EXISTS exact_model TEXT;
ALTER TABLE universal_products ADD COLUMN IF NOT EXISTS material_composition TEXT;
ALTER TABLE universal_products ADD COLUMN IF NOT EXISTS weight_grams NUMERIC(12, 2);
ALTER TABLE universal_products ADD COLUMN IF NOT EXISTS condition_score NUMERIC(3, 2);

CREATE INDEX IF NOT EXISTS idx_universal_products_status ON universal_products(status);
CREATE INDEX IF NOT EXISTS idx_universal_products_created_at ON universal_products(created_at DESC);

-- =============================================================================
-- 2. Channel Adapters (Shopify GID, Amazon ASIN, etc. per product)
-- =============================================================================
CREATE TABLE IF NOT EXISTS channel_adapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES universal_products(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  synced_at TIMESTAMPTZ,
  UNIQUE (product_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_channel_adapters_product_id ON channel_adapters(product_id);
CREATE INDEX IF NOT EXISTS idx_channel_adapters_channel ON channel_adapters(channel);

-- =============================================================================
-- 3. Shopify Stores (OAuth credentials per shop)
-- =============================================================================
CREATE TABLE IF NOT EXISTS shopify_stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_domain TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  scope TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shopify_stores_shop_domain ON shopify_stores(shop_domain);

-- =============================================================================
-- 4. Agentic Engine Tables
-- =============================================================================

-- AI prompt versions (for Feedback Moat)
CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_prompt_versions_slug ON ai_prompt_versions(version_slug);

-- Seed default prompt version
INSERT INTO ai_prompt_versions (version_slug, name)
  VALUES ('fact_feel_proof_v1', 'Fact-Feel-Proof GEO v1')
  ON CONFLICT (version_slug) DO NOTHING;

-- Description variations per product (SEO, TikTok-Viral, Amazon-Bullets, Shopify-Meta)
CREATE TABLE IF NOT EXISTS description_variations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES universal_products(id) ON DELETE CASCADE,
  variation_type TEXT NOT NULL CHECK (variation_type IN ('SEO', 'TIKTOK_VIRAL', 'AMAZON_BULLETS', 'SHOPIFY_META')),
  ai_prompt_version_id UUID REFERENCES ai_prompt_versions(id) ON DELETE SET NULL,
  copy_seo_title TEXT NOT NULL,
  copy_description TEXT NOT NULL,
  copy_bullet_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  copy_fact_feel_proof JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, variation_type)
);

CREATE INDEX IF NOT EXISTS idx_description_variations_product_id ON description_variations(product_id);
CREATE INDEX IF NOT EXISTS idx_description_variations_variation_type ON description_variations(variation_type);

-- Performance logs (Feedback Moat: correlate sales to AI description style)
CREATE TABLE IF NOT EXISTS performance_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES universal_products(id) ON DELETE CASCADE,
  variation_type TEXT NOT NULL,
  ai_prompt_version TEXT NOT NULL,
  click_count INTEGER NOT NULL DEFAULT 0,
  conversion_rate NUMERIC(5, 4) NOT NULL DEFAULT 0,
  orders_count INTEGER NOT NULL DEFAULT 0,
  revenue_cents BIGINT NOT NULL DEFAULT 0,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, variation_type, ai_prompt_version, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_performance_logs_product_id ON performance_logs(product_id);
CREATE INDEX IF NOT EXISTS idx_performance_logs_period ON performance_logs(period_start, period_end);

-- Channel push snapshots (which variation was pushed to which channel)
CREATE TABLE IF NOT EXISTS channel_push_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES universal_products(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  description_variation_id UUID REFERENCES description_variations(id) ON DELETE SET NULL,
  variation_type TEXT NOT NULL,
  ai_prompt_version TEXT NOT NULL,
  pushed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channel_push_snapshots_product_id ON channel_push_snapshots(product_id);
CREATE INDEX IF NOT EXISTS idx_channel_push_snapshots_channel_external ON channel_push_snapshots(channel, external_id);

-- UCP manifests (/.well-known/ucp for agentic discovery)
CREATE TABLE IF NOT EXISTS ucp_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES universal_products(id) ON DELETE CASCADE UNIQUE,
  manifest_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ucp_manifests_product_id ON ucp_manifests(product_id);

-- =============================================================================
-- 5. Snap Pair Sessions (phone ↔ browser extension pairing)
-- =============================================================================
CREATE TABLE IF NOT EXISTS snap_pair_sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  price TEXT,
  image_url TEXT,
  listing_extra JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE snap_pair_sessions ADD COLUMN IF NOT EXISTS listing_extra JSONB DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS snap_pair_sessions_updated_at ON snap_pair_sessions (updated_at DESC);

-- =============================================================================
-- 6. Enable RLS on all public tables + revoke anon/authenticated access
--    (service_role key bypasses RLS and retains full access)
-- =============================================================================
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema_name, r.table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM anon, authenticated', r.schema_name, r.table_name);
  END LOOP;
END $$;

-- =============================================================================
-- Done. All tables created; RLS enabled; anon access revoked.
-- =============================================================================
