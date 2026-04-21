/**
 * Maps Stripe Price IDs ↔ plan tier keys (landing.html / extension).
 */
export const TIER_ORDER = ["starter", "pro", "growth", "scale"] as const;
export type BillingTier = (typeof TIER_ORDER)[number];

export function priceIdsFromEnv(): Record<BillingTier, string | undefined> {
  return {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro: process.env.STRIPE_PRICE_PRO,
    growth: process.env.STRIPE_PRICE_GROWTH,
    scale: process.env.STRIPE_PRICE_SCALE,
  };
}

export function tierForPriceId(priceId: string | undefined | null): BillingTier | null {
  if (!priceId) return null;
  const m = priceIdsFromEnv();
  for (const tier of TIER_ORDER) {
    if (m[tier] === priceId) return tier;
  }
  return null;
}
