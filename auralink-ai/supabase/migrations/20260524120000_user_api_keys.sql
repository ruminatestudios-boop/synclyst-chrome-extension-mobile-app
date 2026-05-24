-- Permanent API keys for MCP / CLI usage.
-- Keys are stored as SHA-256 hashes; the plaintext is shown only once at creation.

create table if not exists public.user_api_keys (
  id              uuid primary key default gen_random_uuid(),
  clerk_user_id   text not null,
  key_hash        text not null unique,          -- SHA-256(raw_key)
  label           text not null default 'MCP key',
  revoked         boolean not null default false,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  updated_at      timestamptz not null default now()
);

-- Index for quick hash lookups (every authenticated API request)
create index if not exists user_api_keys_hash_idx
  on public.user_api_keys (key_hash)
  where revoked = false;

-- Index for listing a user's keys
create index if not exists user_api_keys_user_idx
  on public.user_api_keys (clerk_user_id)
  where revoked = false;

-- Service role can do everything; anon/authenticated roles have no direct access
-- (all access goes through the backend with service key).
alter table public.user_api_keys enable row level security;

create policy "Service role full access"
  on public.user_api_keys
  for all
  to service_role
  using (true)
  with check (true);
