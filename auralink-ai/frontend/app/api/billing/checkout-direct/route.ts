import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

function corsHeaders(req: Request): Headers {
  const h = new Headers();
  const origin = req.headers.get("origin") || "";
  const isExtension = origin.startsWith("chrome-extension://");
  if (!isExtension) return h;
  h.set("access-control-allow-origin", origin);
  h.set("access-control-allow-credentials", "true");
  h.set("access-control-allow-methods", "POST,OPTIONS");
  h.set("access-control-allow-headers", "content-type,authorization");
  h.set("vary", "origin");
  return h;
}

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

export async function POST(req: Request) {
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders(req) });

  const token = await getClerkTokenSafe(getToken);
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 401, headers: corsHeaders(req) });

  let body: { tier?: string; success_url?: string; cancel_url?: string } = {};
  try {
    body = (await req.json()) as { tier?: string; success_url?: string; cancel_url?: string };
  } catch {
    body = {};
  }

  const tier = (body.tier || "").trim().toLowerCase();
  if (tier !== "pro" && tier !== "growth" && tier !== "scale") {
    return NextResponse.json({ error: "invalid_tier" }, { status: 400, headers: corsHeaders(req) });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "") || "http://localhost:3000";
  const origin = appUrl;
  const successUrl =
    (body.success_url || "").trim() || `${origin}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl =
    (body.cancel_url || "").trim() || `${origin}/dashboard?pricing=1&tier=${encodeURIComponent(tier)}&canceled=1`;

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
      { status: upstream.status, headers: corsHeaders(req) }
    );
  }

  const url = data && typeof data === "object" && "url" in data ? (data as { url?: unknown }).url : null;
  if (typeof url !== "string" || !url) {
    return NextResponse.json({ error: "missing_checkout_url" }, { status: 502, headers: corsHeaders(req) });
  }

  return NextResponse.json({ url }, { headers: corsHeaders(req) });
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

