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

async function proxy(req: Request, pathSegments: string[]) {
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const token = await getClerkTokenSafe(getToken);
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 401 });

  const subpath = pathSegments.join("/");
  const url = `${getBackendBaseUrl()}/api/v1/developer/${subpath}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.text();
    if (body) headers["Content-Type"] = "application/json";
  }

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body,
    cache: "no-store",
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    return NextResponse.json(
      { detail: text.slice(0, 800) },
      { status: upstream.status, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    return NextResponse.json(JSON.parse(text), { status: upstream.status });
  } catch {
    return new NextResponse(text, { status: upstream.status });
  }
}

type RouteCtx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function POST(req: Request, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function DELETE(req: Request, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
