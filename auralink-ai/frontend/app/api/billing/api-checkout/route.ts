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
  } catch {
    return await getToken();
  }
}

export async function POST(req: Request) {
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const token = await getClerkTokenSafe(getToken);
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 401 });

  let body: { plan?: string; success_url?: string; cancel_url?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const plan = (body.plan || "").trim().toLowerCase();
  if (plan !== "starter" && plan !== "pro") {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://app.synclyst.app").replace(/\/$/, "");
  const successUrl =
    (body.success_url || "").trim() ||
    `${appUrl}/developers/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = (body.cancel_url || "").trim() || `${appUrl}/developers/dashboard?billing=cancel`;

  const upstream = await fetch(`${getBackendBaseUrl()}/api/v1/billing/api-checkout-session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ plan, success_url: successUrl, cancel_url: cancelUrl }),
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
      { error: "upstream_error", detail: typeof text === "string" ? text.slice(0, 400) : "" },
      { status: upstream.status }
    );
  }

  const url = data && typeof data === "object" && "url" in data ? (data as { url?: unknown }).url : null;
  if (typeof url !== "string" || !url) {
    return NextResponse.json({ error: "missing_checkout_url" }, { status: 502 });
  }

  return NextResponse.json({ url });
}
