import { createClient, SupabaseClient } from "@supabase/supabase-js";

function supabaseUrl(): string | undefined {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL)?.trim() || undefined;
}

function supabaseServiceKey(): string | undefined {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ""
  ).trim() || undefined;
}

export function getSupabaseAdmin(): SupabaseClient | null {
  const url = supabaseUrl();
  const key = supabaseServiceKey();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function isSnapPairConfigured(): boolean {
  return !!(supabaseUrl() && supabaseServiceKey());
}
