/**
 * Resolves Supabase env across common Vercel / dashboard naming.
 */

export function resolveSupabaseProjectUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    process.env.SUPABASE_PROJECT_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
}

/** Legacy `anon` JWT, or new `sb_publishable_…` (Publishable) from Supabase → API keys. */
export function resolveSupabaseAnonKey(): string {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_KEY ||
    ""
  ).trim();
}

export function resolveSupabaseServiceKey(): string | undefined {
  const k = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ""
  ).trim();
  return k || undefined;
}
