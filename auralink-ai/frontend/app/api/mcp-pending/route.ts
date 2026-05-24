/**
 * GET /api/mcp-pending
 *
 * Called by the Chrome extension when it opens on a listing page.
 * Returns the most recently created MCP product for the signed-in user,
 * formatted as a listing the extension can use directly with applyListing().
 *
 * Auth: Clerk session cookie (sent automatically by Chrome for synclyst.app).
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

function getBackendBaseUrl() {
  const raw =
    process.env.AURALINK_BACKEND_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    "http://localhost:8000";
  const base = raw.replace(/\/$/, "");
  const isLocal =
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(base) ||
    /^https?:\/\/\[::1\](:\d+)?\/?$/i.test(base);
  if (process.env.NODE_ENV === "production" && isLocal) return "";
  return base;
}

function corsHeaders(request: NextRequest): HeadersInit {
  const origin = request.headers.get("origin");
  if (origin?.startsWith("chrome-extension://")) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
    };
  }
  return {};
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  try {
    const { userId, getToken } = await auth();
    if (!userId) {
      return NextResponse.json({ found: false, reason: "not_signed_in" }, { status: 200, headers: cors });
    }

    const template = process.env.CLERK_JWT_TEMPLATE?.trim();
    const token = await getToken(template ? { template } : undefined);
    if (!token) {
      return NextResponse.json({ found: false, reason: "no_token" }, { status: 200, headers: cors });
    }

    const base = getBackendBaseUrl();
    if (!base) {
      return NextResponse.json({ found: false, reason: "misconfigured" }, { status: 200, headers: cors });
    }

    const upstream = await fetch(`${base}/api/v1/products/mcp-latest`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!upstream.ok) {
      return NextResponse.json({ found: false, reason: "backend_error" }, { status: 200, headers: cors });
    }

    const data = await upstream.json() as { found: boolean; listing?: Record<string, unknown>; product_id?: string };
    return NextResponse.json(data, { headers: cors });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    return NextResponse.json({ found: false, reason: message }, { status: 200, headers: cors });
  }
}
