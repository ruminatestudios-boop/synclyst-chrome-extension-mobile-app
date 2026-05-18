-- Run in Supabase SQL editor. Enables Realtime for phone ↔ extension pairing.
-- Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

create table if not exists public.snap_pair_sessions (
  session_id text primary key,
  title text,
  description text,
  price text,
  image_url text,
  listing_extra jsonb default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Existing deployments: add column (safe to re-run)
alter table public.snap_pair_sessions add column if not exists listing_extra jsonb default '{}'::jsonb;

create index if not exists snap_pair_sessions_updated_at on public.snap_pair_sessions (updated_at desc);

alter table public.snap_pair_sessions enable row level security;

-- NOTE: To avoid public exposure warnings, do NOT allow anon to read/write this table directly.
-- The app uses Next.js API routes with the Supabase service_role key for reads/writes.
-- With RLS enabled and no policies, anon/authenticated are denied by default.

-- Dashboard: Database → Replication → enable snap_pair_sessions for Realtime, or run:
-- alter publication supabase_realtime add table public.snap_pair_sessions;
