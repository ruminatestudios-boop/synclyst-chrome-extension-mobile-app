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

-- Anon (extension Realtime) can read; writes go through Next.js with the service role (bypasses RLS).
drop policy if exists "snap_pair_read" on public.snap_pair_sessions;
drop policy if exists "snap_pair_write_service" on public.snap_pair_sessions;
create policy "snap_pair_select_anon" on public.snap_pair_sessions
  for select using (true);

-- Dashboard: Database → Replication → enable snap_pair_sessions for Realtime, or run:
-- alter publication supabase_realtime add table public.snap_pair_sessions;
