import { NextResponse } from "next/server";
import Stripe from "stripe";
import { auth, currentUser } from "@clerk/nextjs/server";
import { priceIdsFromEnv, type BillingTier } from "@/lib/stripe-tier-map";

export const runtime = "nodejs";

const paidTiers: BillingTier[] = ["pro", "growth", "scale"];

export async function POST(req: Request) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return NextResponse.json(
      { error: "billing_unconfigured", message: "Stripe is not configured on this deployment." },
      { status: 503 }
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { tier?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const tier = (body.tier || "").toLowerCase() as BillingTier;
  if (!paidTiers.includes(tier)) {
    return NextResponse.json({ error: "invalid_tier" }, { status: 400 });
  }

  const prices = priceIdsFromEnv();
  const priceId = prices[tier];
  if (!priceId) {
    return NextResponse.json(
      { error: "price_not_configured", tier, message: `Set STRIPE_PRICE_${tier.toUpperCase()} in env.` },
      { status: 503 }
    );
  }

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress;

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  if (!appUrl) {
    return NextResponse.json({ error: "app_url_missing" }, { status: 500 });
  }

  const stripe = new Stripe(secret);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      // Route back into the signed-in dashboard so we can confirm -> persist tier in DB (FastAPI /billing/confirm).
      success_url: `${appUrl}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/billing?tier=${encodeURIComponent(tier)}&canceled=1`,
      client_reference_id: userId,
      customer_email: email || undefined,
      metadata: { tier, clerk_user_id: userId },
      subscription_data: {
        metadata: { tier, clerk_user_id: userId },
      },
    });

    if (!session.url) {
      return NextResponse.json({ error: "no_checkout_url" }, { status: 500 });
    }

    return NextResponse.json({ url: session.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[billing/checkout]", msg);
    return NextResponse.json({ error: "stripe_error", message: msg }, { status: 500 });
  }
}
