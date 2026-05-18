import { NextRequest, NextResponse } from "next/server";
import { devGet, devRegisterSession, devUpsert, snapPairDevMemoryActive } from "@/lib/snap-pair-dev-memory";
import { getSupabaseAdmin, isSnapPairConfigured } from "@/lib/supabase-pair";

export const runtime = "nodejs";

function cors(request: NextRequest): HeadersInit {
  const origin = request.headers.get("origin");
  const devHttp =
    process.env.NODE_ENV === "development" && !!origin && /^http:\/\//.test(origin);
  if (
    origin === "https://synclyst.app" ||
    origin?.startsWith("http://localhost") ||
    origin?.startsWith("http://127.0.0.1") ||
    devHttp ||
    origin?.startsWith("chrome-extension://")
  ) {
    return {
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
    };
  }
  return {};
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(request) });
}

export async function PUT(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const h = cors(request);
  const { id } = await ctx.params;
  const sessionId = decodeURIComponent(id || "").trim();
  if (!/^[a-f0-9]{12,32}$/i.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400, headers: h });
  }

  let body: { title?: unknown; description?: unknown; price?: unknown; listing_extra?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: h });
  }

  const titleRaw = typeof body.title === "string" ? body.title : undefined;
  const descriptionRaw = typeof body.description === "string" ? body.description : undefined;
  const rawPrice = body.price;
  const priceRaw =
    rawPrice === undefined || rawPrice === null
      ? undefined
      : typeof rawPrice === "number" && Number.isFinite(rawPrice)
        ? String(rawPrice)
        : typeof rawPrice === "string"
          ? rawPrice
          : undefined;

  /**
   * Guard against accidental wipes: if a client "Save" fires before the form hydrated (or a field is missing),
   * it can send empty strings that would overwrite extracted values. Treat blank strings as "not provided".
   */
  const title = titleRaw !== undefined && titleRaw.trim() === "" ? undefined : titleRaw;
  const description = descriptionRaw !== undefined && descriptionRaw.trim() === "" ? undefined : descriptionRaw;
  const price = priceRaw !== undefined && priceRaw.trim() === "" ? undefined : priceRaw;
  let listingExtra: Record<string, unknown> | null | undefined;
  if (body.listing_extra === undefined) {
    listingExtra = undefined;
  } else if (body.listing_extra === null) {
    listingExtra = null;
  } else if (typeof body.listing_extra === "object" && !Array.isArray(body.listing_extra)) {
    listingExtra = body.listing_extra as Record<string, unknown>;
  } else {
    return NextResponse.json({ error: "listing_extra must be a JSON object or null" }, { status: 400, headers: h });
  }

  if (title === undefined && description === undefined && price === undefined && listingExtra === undefined) {
    return NextResponse.json(
      { error: "Provide at least one of title, description, price, listing_extra" },
      { status: 400, headers: h }
    );
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

  const now = new Date().toISOString();

  if (useDevMemory) {
    let cur = devGet(sessionId);
    if (!cur) {
      devRegisterSession(sessionId);
      cur = devGet(sessionId);
    }
    if (!cur) {
      return NextResponse.json({ error: "Session not found" }, { status: 500, headers: h });
    }
    devUpsert({
      ...cur,
      title: title !== undefined ? title : cur.title,
      description: description !== undefined ? description : cur.description,
      price: price !== undefined ? price : cur.price,
      listing_extra: listingExtra !== undefined ? listingExtra : cur.listing_extra,
      updated_at: now,
    });
    return NextResponse.json({ ok: true }, { status: 200, headers: h });
  }

  const { data: cur, error: fetchErr } = await supabase!
    .from("snap_pair_sessions")
    .select("session_id,title,description,price,image_url,listing_extra")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500, headers: h });
  }

  if (!cur) {
    const insertRow: Record<string, unknown> = {
      session_id: sessionId,
      title: title !== undefined ? title : "",
      description: description !== undefined ? description : "",
      price: price !== undefined ? price : "",
      listing_extra: listingExtra !== undefined ? listingExtra : {},
      updated_at: now,
    };
    const { error: insErr } = await supabase!.from("snap_pair_sessions").insert(insertRow);
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500, headers: h });
    }
    return NextResponse.json({ ok: true }, { status: 200, headers: h });
  }

  const row: Record<string, unknown> = {
    title: title !== undefined ? title : cur.title,
    description: description !== undefined ? description : cur.description,
    price: price !== undefined ? price : cur.price,
    updated_at: now,
  };
  if (listingExtra !== undefined) {
    row.listing_extra = listingExtra;
  }
  const { error: updErr } = await supabase!.from("snap_pair_sessions").update(row).eq("session_id", sessionId);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500, headers: h });
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: h });
}
