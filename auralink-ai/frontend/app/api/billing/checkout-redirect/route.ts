import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { createClerkSubscriptionCheckoutUrl, isPaidTier, type PaidTier } from "@/lib/billing-stripe";

export const runtime = "nodejs";

function getBackendBaseUrl() {
  const raw =
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    process.env.AURALINK_BACKEND_URL?.trim() ||
    "http://localhost:8000";
  return raw.replace(/\/$/, "");
}

async function getClerkTokenSafe(getToken: (opts?: { template?: string }) => Promise<string | null>) {
  const template = process.env.CLERK_JWT_TEMPLATE?.trim();
  if (!template) return await getToken();
  try {
    return await getToken({ template });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/jwt template exists with name/i.test(msg)) {
      return await getToken();
    }
    return null;
  }
}

/**
 * GET entry so the extension can `chrome.tabs.create` a single URL: Clerk + Stripe, then Stripe-hosted checkout.
 * Prefer Stripe on this Next server (Vercel env) — the Python service is only a fallback.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const raw = (u.searchParams.get("tier") || "").trim().toLowerCase();
  if (!isPaidTier(raw)) {
    return NextResponse.json({ error: "invalid_tier" }, { status: 400 });
  }
  const tier = raw as PaidTier;

  let userId: string | null = null;
  let getToken: ((opts?: { template?: string }) => Promise<string | null>) | undefined;

  try {
    const authRes = await auth();
    userId = authRes.userId;
    getToken = authRes.getToken;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[checkout-redirect] auth", msg);
    return NextResponse.json({ error: "auth_failed", message: msg }, { status: 500 });
  }

  if (!userId) {
    const redirectUrl = `/api/billing/checkout-redirect?tier=${encodeURIComponent(tier)}`;
    return NextResponse.redirect(new URL(`/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`, u.origin));
  }

  const successUrl = `${u.origin}/extension-return?billing=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${u.origin}/extension-return?canceled=1&tier=${encodeURIComponent(tier)}`;

  if (process.env.STRIPE_SECRET_KEY?.trim()) {
    let email: string | undefined;
    try {
      const user = await currentUser();
      email = user?.emailAddresses?.[0]?.emailAddress;
    } catch {
      /* optional */
    }
    try {
      const checkoutUrl = await createClerkSubscriptionCheckoutUrl({
        tier,
        userId,
        email,
        successUrl,
        cancelUrl,
      });
      return NextResponse.redirect(checkoutUrl, { status: 302 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[checkout-redirect] stripe", msg);
      // Fall through to Python (legacy / dev) when Stripe is misconfigured
    }
  }

  if (!getToken) {
    return NextResponse.json({ error: "missing_getToken" }, { status: 500 });
  }

  const token = await getClerkTokenSafe(getToken);
  if (!token) {
    const redirectUrl = `/api/billing/checkout-redirect?tier=${encodeURIComponent(tier)}`;
    return NextResponse.redirect(new URL(`/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`, u.origin));
  }

  try {
    const upstream = await fetch(`${getBackendBaseUrl()}/api/v1/billing/checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ tier, success_url: successUrl, cancel_url: cancelUrl }),
      cache: "no-store",
    });

    const text = await upstream.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!upstream.ok) {
      return NextResponse.json(
        { error: "upstream_error", status: upstream.status, detail: typeof text === "string" ? text.slice(0, 400) : "" },
        { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 }
      );
    }

    const url = data && typeof data === "object" && "url" in data ? (data as { url?: unknown }).url : null;
    if (typeof url !== "string" || !url) {
      return NextResponse.json({ error: "missing_checkout_url" }, { status: 502 });
    }

    return NextResponse.redirect(url, { status: 302 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[checkout-redirect] fetch", msg);
    return NextResponse.json({ error: "checkout_failed", message: msg }, { status: 502 });
  }
}
