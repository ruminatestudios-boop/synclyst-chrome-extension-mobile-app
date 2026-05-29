import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, isSnapPairConfigured } from "@/lib/supabase-pair";

export const runtime = "nodejs";

/** Fetch a snap_pair_sessions row by session_id for the extension-review page. */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = (searchParams.get("s") || "").trim();

  if (!/^[a-f0-9]{12,32}$/i.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }

  if (!isSnapPairConfigured()) {
    return NextResponse.json({ error: "Snap pair not configured" }, { status: 503 });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  const { data, error } = await supabase
    .from("snap_pair_sessions")
    .select("session_id, title, description, price, image_url, listing_extra, updated_at")
    .eq("session_id", sessionId)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      // No rows found
      return NextResponse.json({ listing: null }, { status: 200 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ listing: data }, { status: 200 });
}
