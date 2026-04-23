import { NextRequest, NextResponse } from "next/server";
import { devRegisterSession, snapPairDevMemoryActive } from "@/lib/snap-pair-dev-memory";
import { getSupabaseAdmin, isSnapPairConfigured } from "@/lib/supabase-pair";

export const runtime = "nodejs";

function cors(request: NextRequest): HeadersInit {
  const origin = request.headers.get("origin");
  if (origin?.startsWith("chrome-extension://")) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
    };
  }
  if (!origin) {
    return { "Access-Control-Allow-Origin": "*" };
  }
  return {};
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(request) });
}

/** Register or refresh an empty pairing row so Realtime subscriptions see the session. */
export async function POST(request: NextRequest) {
  const h = cors(request);
  const useDevMemory = snapPairDevMemoryActive() && !isSnapPairConfigured();
  const supabase = useDevMemory ? null : getSupabaseAdmin();
  if (!useDevMemory) {
    if (!isSnapPairConfigured()) {
      return NextResponse.json({ error: "Snap pair not configured" }, { status: 503, headers: h });
    }
    if (!supabase) {
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500, headers: h });
    }
  }
  let body: { session_id?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: h });
  }
  const sessionId = String(body.session_id || "").trim();
  if (!/^[a-f0-9]{12,32}$/i.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400, headers: h });
  }
  if (useDevMemory) {
    devRegisterSession(sessionId);
    return NextResponse.json({ ok: true }, { headers: h });
  }

  const { error } = await supabase!.from("snap_pair_sessions").upsert(
    {
      session_id: sessionId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id" }
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: h });
  }
  return NextResponse.json({ ok: true }, { headers: h });
}
