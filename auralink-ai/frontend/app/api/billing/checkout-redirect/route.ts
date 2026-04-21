import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

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

function safeTier(value: string | null): "pro" | "growth" | "scale" | null {
  const t = (value || "").trim().toLowerCase();
  if (t === "pro" || t === "growth" || t === "scale") return t;
  return null;
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const tier = safeTier(u.searchParams.get("tier"));
  if (!tier) {
    return NextResponse.json({ error: "invalid_tier" }, { status: 400 });
  }

  // If not signed in, send the user to sign-in and come back here.
  const { userId, getToken } = await auth();
  if (!userId) {
    const redirectUrl = `/api/billing/checkout-redirect?tier=${encodeURIComponent(tier)}`;
    return NextResponse.redirect(new URL(`/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`, u.origin));
  }

  const token = await getClerkTokenSafe(getToken);
  if (!token) {
    const redirectUrl = `/api/billing/checkout-redirect?tier=${encodeURIComponent(tier)}`;
    return NextResponse.redirect(new URL(`/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`, u.origin));
  }

  const successUrl = `${u.origin}/extension-return?billing=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${u.origin}/extension-return?canceled=1&tier=${encodeURIComponent(tier)}`;

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
      { status: upstream.status }
    );
  }

  const url = data && typeof data === "object" && "url" in data ? (data as { url?: unknown }).url : null;
  if (typeof url !== "string" || !url) {
    return NextResponse.json({ error: "missing_checkout_url" }, { status: 502 });
  }

  return NextResponse.redirect(url, { status: 302 });
}

