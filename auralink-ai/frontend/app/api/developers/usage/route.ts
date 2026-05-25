/** Proxy GET /api/developers/usage → FastAPI /v1/developers/keys/usage */
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

const BACKEND = (
  process.env.AURALINK_BACKEND_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://auralink-api-299567386855.us-central1.run.app"
).replace(/\/$/, "");

export async function GET() {
  try {
    const { getToken } = await auth();
    const token = await getToken();
    if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const upstream = await fetch(`${BACKEND}/v1/developers/keys/usage`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await upstream.text();
    return new NextResponse(body, { status: upstream.status, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
