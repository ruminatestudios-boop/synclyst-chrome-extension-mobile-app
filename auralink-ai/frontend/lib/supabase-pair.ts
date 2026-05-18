import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { resolveSupabaseProjectUrl, resolveSupabaseServiceKey } from "./supabase-env";

export function getSupabaseAdmin(): SupabaseClient | null {
  const url = resolveSupabaseProjectUrl() || undefined;
  const key = resolveSupabaseServiceKey();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function isSnapPairConfigured(): boolean {
  return !!(resolveSupabaseProjectUrl() && resolveSupabaseServiceKey());
}
