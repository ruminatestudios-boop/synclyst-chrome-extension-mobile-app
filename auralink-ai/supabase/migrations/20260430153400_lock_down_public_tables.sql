-- Lock down public tables (RLS + no anon access).
-- This repo uses server-side Supabase service_role for DB access (Next.js API routes),
-- so we can safely deny anon/authenticated and eliminate "publicly accessible" warnings.

-- ---------------------------------------------------------------------------
-- Snap Pair sessions (phone ↔ extension pairing)
-- ---------------------------------------------------------------------------
create table if not exists public.snap_pair_sessions (
  session_id text primary key,
  title text,
  description text,
  price text,
  image_url text,
  listing_extra jsonb default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.snap_pair_sessions add column if not exists listing_extra jsonb default '{}'::jsonb;

create index if not exists snap_pair_sessions_updated_at on public.snap_pair_sessions (updated_at desc);

-- ---------------------------------------------------------------------------
-- Enable RLS on all app tables
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select n.nspname as schema_name, c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p') -- ordinary table, partitioned table
  loop
    execute format(
      'alter table %I.%I enable row level security',
      r.schema_name,
      r.table_name
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Revoke API access for anon/authenticated (defense-in-depth).
-- Service role bypasses RLS and retains access.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select n.nspname as schema_name, c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
  loop
    execute format(
      'revoke all on table %I.%I from anon, authenticated',
      r.schema_name,
      r.table_name
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Remove permissive policies if they exist (older deployments / experiments).
-- With RLS enabled and no policies, anon/authenticated can't read/write.
-- ---------------------------------------------------------------------------
do $$
begin
  -- snap_pair_sessions
  execute 'drop policy if exists "snap_pair_read" on public.snap_pair_sessions';
  execute 'drop policy if exists "snap_pair_write_service" on public.snap_pair_sessions';
  execute 'drop policy if exists "snap_pair_select_anon" on public.snap_pair_sessions';

  -- common blanket policy names (best effort)
  execute 'drop policy if exists "public_read" on public.snap_pair_sessions';
  execute 'drop policy if exists "public_write" on public.snap_pair_sessions';
exception
  when undefined_table then null;
end $$;

