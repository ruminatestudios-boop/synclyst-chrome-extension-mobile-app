/**
 * Resolves Supabase env across common Vercel / dashboard naming.
 */

export function resolveSupabaseProjectUrl(): string {
  /**
   * Server routes should prefer `SUPABASE_URL` (server-only) over `NEXT_PUBLIC_SUPABASE_URL`
   * to avoid accidentally picking a stale public value in production.
   */
  return (
    process.env.SUPABASE_URL ||
    process.env.SUPABASE_PROJECT_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ""
  ).trim().replace(/\/$/, "");
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
  if (!k) return undefined;

  // Guardrail: service role key must actually be `service_role`.
  // A common production misconfig is pasting the anon/publishable key into SUPABASE_SERVICE_*,
  // which will trigger RLS errors like:
  // "new row violates row-level security policy for table ..."
  try {
    const looksLikeJwt = k.split(".").length === 3;
    if (looksLikeJwt) {
      const payloadB64 = k.split(".")[1] || "";
      const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payloadB64.length / 4) * 4, "=");
      const json = Buffer.from(padded, "base64").toString("utf8");
      const payload = JSON.parse(json) as { role?: unknown } | null;
      const role = payload && typeof payload === "object" ? (payload as { role?: unknown }).role : undefined;
      if (role && role !== "service_role") return undefined;
    }
  } catch {
    // If we can't parse it, don't block; Supabase keys may change format.
  }

  return k;
}
