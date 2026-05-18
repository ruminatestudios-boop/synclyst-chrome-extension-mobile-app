-- Purchased bonus scan credits for guest devices (anon UUID from X-SyncLyst-Anon-Id).
-- Free daily scans still tracked in user_scan_usage_monthly with clerk_user_id = 'anon:<uuid>'.
CREATE TABLE IF NOT EXISTS anonymous_scan_credits (
  anon_id TEXT PRIMARY KEY,
  credits INT NOT NULL DEFAULT 0 CHECK (credits >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE anonymous_scan_credits IS 'Stripe top-up credits keyed by device anon_id (without anon: prefix).';
