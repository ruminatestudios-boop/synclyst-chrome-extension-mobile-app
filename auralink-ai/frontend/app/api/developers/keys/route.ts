/**
 * Proxy /api/developers/keys → FastAPI /v1/developers/keys
 * GET  — list developer keys
 * POST — create developer key
 */
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

const BACKEND = (
  process.env.AURALINK_BACKEND_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://auralink-api-299567386855.us-central1.run.app"
).replace(/\/$/, "");

async function _clerkToken(): Promise<string | null> {
  try {
    const { getToken } = await auth();
    return (await getToken()) ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const token = await _clerkToken();
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const upstream = await fetch(`${BACKEND}/v1/developers/keys`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request) {
  const token = await _clerkToken();
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    bodyJson = {};
  }

  const upstream = await fetch(`${BACKEND}/v1/developers/keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(bodyJson),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
