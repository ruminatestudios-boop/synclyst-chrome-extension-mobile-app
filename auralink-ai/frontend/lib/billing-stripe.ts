import Stripe from "stripe";
import { priceIdsFromEnv } from "@/lib/stripe-tier-map";

const paidTiers = ["pro", "growth", "scale"] as const;
export type PaidTier = (typeof paidTiers)[number];

function isPaidTier(t: string): t is PaidTier {
  return (paidTiers as readonly string[]).includes(t);
}

/**
 * Create a Stripe subscription Checkout session URL. Used from Next API routes
 * (Vercel has STRIPE_SECRET_KEY; no dependency on the Python API).
 */
export async function createClerkSubscriptionCheckoutUrl(params: {
  tier: PaidTier;
  userId: string;
  email?: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new Error("STRIPE_SECRET_KEY is not set on this server");
  }
  const map = priceIdsFromEnv();
  const priceId = map[params.tier];
  if (!priceId) {
    throw new Error(`STRIPE_PRICE_${params.tier.toUpperCase()} is not set`);
  }
  const stripe = new Stripe(secret);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    client_reference_id: params.userId,
    customer_email: params.email || undefined,
    metadata: { tier: params.tier, clerk_user_id: params.userId },
    subscription_data: {
      metadata: { tier: params.tier, clerk_user_id: params.userId },
    },
  });
  if (!session.url) {
    throw new Error("Stripe did not return a checkout session URL");
  }
  return session.url;
}

export { isPaidTier, paidTiers };
