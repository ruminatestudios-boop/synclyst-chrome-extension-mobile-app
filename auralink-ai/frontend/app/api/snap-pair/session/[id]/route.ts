import { NextRequest, NextResponse } from "next/server";
import { devGet, snapPairDevMemoryActive } from "@/lib/snap-pair-dev-memory";
import { getSupabaseAdmin, isSnapPairConfigured } from "@/lib/supabase-pair";

export const runtime = "nodejs";

/** Match extension `sessionListingHasContent` — do not hide rows that only have image / price / gallery yet. */
function snapPairRowHasListingPayload(row: Record<string, unknown>): boolean {
  const t = typeof row.title === "string" ? row.title.trim() : "";
  const d = typeof row.description === "string" ? row.description.trim() : "";
  if (t || d) return true;
  if (row.price !== undefined && row.price !== null && String(row.price).trim() !== "") return true;
  const looksLikeRawBase64 = (s: string): boolean => {
    const t = String(s || "").trim();
    if (t.length < 256) return false;
    if (t.startsWith("data:") || t.startsWith("http") || t.startsWith("blob:")) return false;
    return /^[A-Za-z0-9+/=\s]+$/.test(t);
  };
  const img = row.image_url != null ? String(row.image_url).trim() : "";
  if (img && (img.startsWith("data:") || img.startsWith("http") || img.startsWith("blob:") || looksLikeRawBase64(img)))
    return true;
  const le = row.listing_extra;
  if (!le || typeof le !== "object" || Array.isArray(le)) return false;
  const media = (le as Record<string, unknown>).media;
  if (!media || typeof media !== "object" || Array.isArray(media)) return false;
  const urls = (media as Record<string, unknown>).image_urls;
  if (!Array.isArray(urls)) return false;
  return urls.some(
    (u) =>
      typeof u === "string" &&
      u.trim() !== "" &&
      (u.startsWith("data:") || u.startsWith("http") || u.startsWith("blob:") || looksLikeRawBase64(u))
  );
}

function cors(request: NextRequest): HeadersInit {
  const origin = request.headers.get("origin");
  if (origin?.startsWith("chrome-extension://")) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept",
    };
  }
  // MV3 popups / extension fetches sometimes omit `Origin` — without ACAO, `fetch` fails CORS and the
  // popup never reads listing JSON (looks like "stuck extracting" forever).
  if (!origin) {
    return { "Access-Control-Allow-Origin": "*" };
  }
  return {};
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(request) });
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const h = cors(request);
  const { id } = await ctx.params;
  const sessionId = decodeURIComponent(id || "").trim();
  if (!/^[a-f0-9]{12,32}$/i.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400, headers: h });
  }
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

  if (useDevMemory) {
    const data = devGet(sessionId);
    if (!data) {
      return NextResponse.json({ empty: true }, { status: 200, headers: h });
    }
    const row = { ...data } as Record<string, unknown>;
    const le = row.listing_extra;
    if (typeof le === "string") {
      try {
        row.listing_extra = le.trim() ? (JSON.parse(le) as unknown) : {};
      } catch {
        row.listing_extra = {};
      }
    }
    if (!snapPairRowHasListingPayload(row)) {
      return NextResponse.json({ empty: true }, { status: 200, headers: h });
    }
    return NextResponse.json({ empty: false, listing: row }, { status: 200, headers: h });
  }

  const { data, error } = await supabase!
    .from("snap_pair_sessions")
    .select("session_id,title,description,price,image_url,listing_extra,updated_at")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: h });
  }
  if (!data) {
    return NextResponse.json({ empty: true }, { status: 200, headers: h });
  }
  const row = data as Record<string, unknown>;
  const le = row.listing_extra;
  if (typeof le === "string") {
    try {
      row.listing_extra = le.trim() ? (JSON.parse(le) as unknown) : {};
    } catch {
      row.listing_extra = {};
    }
  }
  if (!snapPairRowHasListingPayload(row)) {
    return NextResponse.json({ empty: true }, { status: 200, headers: h });
  }
  return NextResponse.json({ empty: false, listing: row }, { status: 200, headers: h });
}
