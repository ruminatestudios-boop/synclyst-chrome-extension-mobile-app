import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, isSnapPairConfigured } from "@/lib/supabase-pair";
import { snapPairDevMemoryActive } from "@/lib/snap-pair-dev-memory";

export const runtime = "nodejs";

function cors(request: NextRequest): HeadersInit {
  const origin = request.headers.get("origin");
  const devHttp = process.env.NODE_ENV === "development" && !!origin && /^http:\/\//.test(origin);
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
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
    };
  }
  return {};
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(request) });
}

function pickExtFromMime(mime: string): string {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "jpg";
}

export async function POST(request: NextRequest) {
  const h = cors(request);
  if (snapPairDevMemoryActive() && !isSnapPairConfigured()) {
    return NextResponse.json(
      { error: "Original upload requires Supabase Storage (configure NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)" },
      { status: 503, headers: h }
    );
  }
  if (!isSnapPairConfigured()) {
    return NextResponse.json({ error: "Snap pair not configured" }, { status: 503, headers: h });
  }
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500, headers: h });
  }

  let body: { session_id?: unknown; image_base64?: unknown; mime_type?: unknown; role?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: h });
  }

  const sessionId = String(body.session_id || "").trim();
  const b64Raw = String(body.image_base64 || "").trim();
  const mime = String(body.mime_type || "image/jpeg").trim() || "image/jpeg";
  const role = String(body.role || "extra").trim().toLowerCase();

  if (!/^[a-f0-9]{12,32}$/i.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400, headers: h });
  }
  if (!b64Raw) {
    return NextResponse.json({ error: "Missing image_base64" }, { status: 400, headers: h });
  }

  const b64 = b64Raw.replace(/^data:[^;]+;base64,/, "");
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return NextResponse.json({ error: "Bad base64 payload" }, { status: 400, headers: h });
  }
  if (!buf || buf.length < 64) {
    return NextResponse.json({ error: "Bad image payload" }, { status: 400, headers: h });
  }

  const bucket = (process.env.SUPABASE_SNAP_PAIR_BUCKET || "snap-pair").trim() || "snap-pair";
  const ext = pickExtFromMime(mime);
  const safeRole = role === "hero" ? "hero" : "extra";
  const ts = Date.now();
  const rand = Math.random().toString(16).slice(2, 10);
  const path = `originals/${sessionId}/${safeRole}-${ts}-${rand}.${ext}`;

  const { error: upErr } = await supabase.storage.from(bucket).upload(path, buf, {
    contentType: mime,
    upsert: false,
    cacheControl: "3600",
  });
  if (upErr) {
    console.error("[api/snap-pair/upload-original] storage upload failed", {
      bucket,
      path,
      message: upErr.message,
    });
    return NextResponse.json({ error: upErr.message }, { status: 500, headers: h });
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  const publicUrl = data?.publicUrl || "";
  if (!publicUrl) {
    console.error("[api/snap-pair/upload-original] missing public URL after upload", { bucket, path });
    return NextResponse.json(
      { error: `Upload ok but could not compute public URL. Ensure bucket "${bucket}" is public, or switch to signed URLs.` },
      { status: 500, headers: h }
    );
  }

  return NextResponse.json({ ok: true, url: publicUrl, path, bucket }, { headers: h });
}

