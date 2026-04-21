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

export async function POST(req: Request) {
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const template = process.env.CLERK_JWT_TEMPLATE?.trim();
  const token = await getToken(template ? { template } : undefined);
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 401 });

  let body: { return_url?: string } = {};
  try {
    body = (await req.json()) as { return_url?: string };
  } catch {
    body = {};
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  const returnUrl =
    (body.return_url || "").trim() || (appUrl ? `${appUrl}/dashboard` : "http://localhost:3000/dashboard");

  const upstream = await fetch(`${getBackendBaseUrl()}/api/v1/billing/portal`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ return_url: returnUrl }),
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

  if (!data || typeof data !== "object" || !("url" in data)) {
    return NextResponse.json({ error: "invalid_response" }, { status: 502 });
  }

  const url = (data as { url?: unknown }).url;
  if (typeof url !== "string" || !url) {
    return NextResponse.json({ error: "missing_portal_url" }, { status: 502 });
  }

  return NextResponse.json({ url });
}

