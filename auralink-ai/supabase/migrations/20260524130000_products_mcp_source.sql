-- Add clerk_user_id and source columns to universal_products
-- Allows MCP-created products to be fetched by the Chrome extension

alter table public.universal_products
  add column if not exists clerk_user_id text,
  add column if not exists source text default 'snap';

-- Index for fast "latest MCP product per user" lookup
create index if not exists universal_products_mcp_user_idx
  on public.universal_products (clerk_user_id, created_at desc)
  where source = 'mcp';
