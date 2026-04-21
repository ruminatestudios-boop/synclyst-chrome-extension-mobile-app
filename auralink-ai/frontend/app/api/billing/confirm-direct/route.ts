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

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function POST(req: Request) {
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders(req) });

  const token = await getClerkTokenSafe(getToken);
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 401, headers: corsHeaders(req) });

  let body: { session_id?: string } = {};
  try {
    body = (await req.json()) as { session_id?: string };
  } catch {
    body = {};
  }
  const sessionId = (body.session_id || "").trim();
  if (!sessionId) {
    return NextResponse.json({ error: "missing_session_id" }, { status: 400, headers: corsHeaders(req) });
  }

  const upstream = await fetch(`${getBackendBaseUrl()}/api/v1/billing/confirm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ session_id: sessionId }),
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

  return NextResponse.json(data ?? { ok: true }, { headers: corsHeaders(req) });
}

