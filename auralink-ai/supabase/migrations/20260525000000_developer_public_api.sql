-- ============================================================================
-- Synclyst Public API — developer tables
-- Run this in Supabase SQL Editor.
-- ============================================================================

-- developer_api_keys: sk_live_ / sk_test_ keys issued to external developers.
-- Completely separate from user_api_keys (internal syn_live_ MCP keys).
create table if not exists public.developer_api_keys (
  id                      uuid primary key default gen_random_uuid(),
  developer_id            text not null,          -- Clerk user ID of the developer
  key_hash                text not null unique,    -- SHA-256(raw_key) — never store plaintext
  key_prefix              text not null,           -- first ~20 chars for display (e.g. sk_live_abc123...)
  plan                    text not null default 'free'
    check (plan in ('free', 'starter', 'pro', 'enterprise')),
  status                  text not null default 'active'
    check (status in ('active', 'suspended', 'revoked')),
  label                   text not null default 'My API Key',
  calls_used_this_month   integer not null default 0,
  month_key               text,                   -- YYYY-MM of current billing window
  stripe_customer_id      text,
  stripe_subscription_id  text,
  created_at              timestamptz not null default now(),
  last_used_at            timestamptz,
  updated_at              timestamptz default now()
);

create index if not exists developer_api_keys_developer_id_idx
  on public.developer_api_keys (developer_id);

create index if not exists developer_api_keys_key_hash_idx
  on public.developer_api_keys (key_hash);

create index if not exists developer_api_keys_status_idx
  on public.developer_api_keys (developer_id, status);


-- developer_usage_log: one row per API call for billing + analytics.
create table if not exists public.developer_usage_log (
  id                uuid primary key default gen_random_uuid(),
  api_key_id        uuid references public.developer_api_keys(id) on delete cascade,
  endpoint          text not null,                -- extract | market_value | classify | value
  timestamp         timestamptz not null default now(),
  response_time_ms  integer,
  success           boolean not null default true,
  error_code        text,
  calls_cost_usd    numeric(10, 4) not null default 0
);

create index if not exists developer_usage_log_key_time_idx
  on public.developer_usage_log (api_key_id, timestamp desc);

create index if not exists developer_usage_log_timestamp_idx
  on public.developer_usage_log (timestamp desc);


-- Row-level security: developers can only see their own keys via service role.
-- The backend uses service role key, so RLS is purely belt-and-suspenders.
alter table public.developer_api_keys enable row level security;
alter table public.developer_usage_log enable row level security;

-- Service role bypasses RLS (backend uses service role).
create policy "service role full access developer_api_keys"
  on public.developer_api_keys
  using (true)
  with check (true);

create policy "service role full access developer_usage_log"
  on public.developer_usage_log
  using (true)
  with check (true);
