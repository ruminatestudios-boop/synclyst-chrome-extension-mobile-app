import { normalizeMyshopifyDomain } from "@/lib/publishingJwt";

/**
 * Same row-level delete as publishing `redactShopFromDatabase` (Supabase REST).
 * Used by GDPR `shop/redact` on Vercel when service role env is set.
 */
export async function deleteShopifyPlatformTokens(
  shopDomain: string
): Promise<{ ok: boolean; error?: string }> {
  const domain = normalizeMyshopifyDomain(shopDomain);
  if (!domain) return { ok: false, error: "invalid_shop_domain" };

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ""
  ).trim();

  if (!supabaseUrl || !serviceKey) {
    console.warn(
      "[shopify/gdpr] shop/redact: SUPABASE_URL or service role key missing; cannot delete platform_tokens on this host"
    );
    return { ok: true };
  }

  const base = supabaseUrl.replace(/\/$/, "");
  const url = `${base}/rest/v1/platform_tokens?platform=eq.shopify&shop_domain=eq.${encodeURIComponent(domain)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "return=minimal",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text || res.statusText };
  }
  return { ok: true };
}
