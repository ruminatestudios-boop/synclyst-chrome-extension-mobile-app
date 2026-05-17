import { NextResponse } from "next/server";
import Stripe from "stripe";
import { auth } from "@clerk/nextjs/server";
import { tierForPriceId, type BillingTier } from "@/lib/stripe-tier-map";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return NextResponse.json({ error: "billing_unconfigured" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const sessionId = (searchParams.get("session_id") || "").trim();
  if (!sessionId || !/^cs_[a-zA-Z0-9_]+$/.test(sessionId)) {
    return NextResponse.json({ error: "invalid_session_id" }, { status: 400 });
  }

  const stripe = new Stripe(secret);

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "line_items.data.price"],
    });

    if (session.client_reference_id && session.client_reference_id !== userId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    let tier: BillingTier | null = null;
    const meta = session.metadata?.tier;
    if (meta && /^(starter|pro|growth|scale)$/.test(meta)) {
      tier = meta as BillingTier;
    }
    if (!tier && session.line_items?.data?.length) {
      const priceId = session.line_items.data[0]?.price?.id;
      tier = tierForPriceId(priceId);
    }

    return NextResponse.json({
      status: session.status,
      payment_status: session.payment_status,
      tier: tier || "starter",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "stripe_error", message: msg }, { status: 400 });
  }
}
