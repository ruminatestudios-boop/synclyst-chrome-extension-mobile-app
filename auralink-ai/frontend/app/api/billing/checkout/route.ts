import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { createClerkSubscriptionCheckoutUrl, isPaidTier, type PaidTier } from "@/lib/billing-stripe";

export const runtime = "nodejs";

export async function POST(req: Request) {
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

  const raw = (body.tier || "").toLowerCase();
  if (!isPaidTier(raw)) {
    return NextResponse.json({ error: "invalid_tier" }, { status: 400 });
  }
  const tier = raw as PaidTier;

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress;

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  if (!appUrl) {
    return NextResponse.json({ error: "app_url_missing" }, { status: 500 });
  }

  try {
    const url = await createClerkSubscriptionCheckoutUrl({
      tier,
      userId,
      email,
      successUrl: `${appUrl}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}/billing?tier=${encodeURIComponent(tier)}&canceled=1`,
    });
    return NextResponse.json({ url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[billing/checkout]", msg);
    if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("STRIPE_PRICE_")) {
      return NextResponse.json(
        { error: "billing_unconfigured", message: "Stripe is not fully configured on this deployment." },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: "stripe_error", message: msg }, { status: 500 });
  }
}
