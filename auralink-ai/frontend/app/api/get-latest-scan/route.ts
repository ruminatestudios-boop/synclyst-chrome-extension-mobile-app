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
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(base) || /^https?:\/\/\[::1\](:\d+)?\/?$/i.test(base);
  if (process.env.NODE_ENV === "production" && isLocal) {
    return "";
  }
  return base;
}

function corsHeaders(request: NextRequest): HeadersInit {
  const origin = request.headers.get("origin");
  if (origin && origin.startsWith("chrome-extension://")) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    };
  }
  return {};
}

function normalizeScan(row: Record<string, unknown>) {
  const title = String(row.copy_seo_title ?? "");
  const description = String(row.copy_description ?? "");
  let price = "";
  const bullets = row.copy_bullet_points;
  if (Array.isArray(bullets)) {
    const hit = bullets.find(
      (b) => typeof b === "string" && /[\d$£€]/.test(b)
    );
    if (hit) price = String(hit).replace(/^.*?([\d.,]+).*$/, "$1").trim();
  }
  const pv = price ? parseFloat(price.replace(",", ".")) : NaN;
  return {
    title,
    description,
    price,
    copy_seo_title: title,
    copy_description: description,
    ...(Number.isFinite(pv) ? { price_value: pv } : {}),
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  try {
    const { userId, getToken } = await auth();
    if (!userId) {
      return NextResponse.json(
        { error: "Sign in at synclyst.app to load your latest scan." },
        { status: 401, headers: cors }
      );
    }
    const template = process.env.CLERK_JWT_TEMPLATE?.trim();
    const token = await getToken(template ? { template } : undefined);
    if (!token) {
      return NextResponse.json(
        { error: "Missing session token. Open synclyst.app and sign in again." },
        { status: 401, headers: cors }
      );
    }

    const base = getBackendBaseUrl();
    if (!base) {
      return NextResponse.json(
        { error: "Server misconfigured: set AURALINK_BACKEND_URL to your live backend." },
        { status: 500, headers: cors }
      );
    }
    const backendUrl = `${base}/api/v1/products?limit=1&offset=0`;
    const upstream = await fetch(backendUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return NextResponse.json(
        { error: "Could not load products from SyncLyst.", detail: text.slice(0, 200) },
        { status: upstream.status, headers: cors }
      );
    }

    const list = (await upstream.json()) as unknown;
    if (!Array.isArray(list) || list.length === 0) {
      return NextResponse.json(
        { error: "No saved scans yet. Complete a scan and save a draft in SyncLyst first." },
        { status: 404, headers: cors }
      );
    }

    const row = list[0] as Record<string, unknown>;
    const scan = normalizeScan(row);
    return NextResponse.json(
      {
        ok: true,
        productId: row.id,
        scan,
      },
      { headers: cors }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500, headers: cors });
  }
}
