import { NextRequest, NextResponse } from "next/server";
import { devGet, devUpsert, snapPairDevMemoryActive } from "@/lib/snap-pair-dev-memory";
import { getSupabaseAdmin, isSnapPairConfigured } from "@/lib/supabase-pair";
import { buildShopifyListingExtraFromVision, mergeShopifyIntoListingExtra } from "@/lib/snap-pair-shopify-extra";
import {
  buildEbayListingExtraFromVision,
  descriptionFromVisionExtraction,
  mergeEbayIntoListingExtra,
} from "@/lib/snap-pair-ebay-extra";
import { buildVintedListingExtraFromVision, mergeVintedIntoListingExtra } from "@/lib/snap-pair-vinted-extra";
import { buildShopeeListingExtraFromVision, mergeShopeeIntoListingExtra } from "@/lib/snap-pair-shopee-extra";
import { buildEtsyListingExtraFromVision, mergeEtsyIntoListingExtra } from "@/lib/snap-pair-etsy-extra";
import { buildDepopListingExtraFromVision, mergeDepopIntoListingExtra } from "@/lib/snap-pair-depop-extra";

export const runtime = "nodejs";

export const maxDuration = 120;

/** Vision JSON sometimes has non-strings from models; avoid .trim() throwing. */
function asTrimmedString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
  return "";
}

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
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
    };
  }
  return {};
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(request) });
}

function backendBase() {
  // Prefer explicit server URL: NEXT_PUBLIC_API_URL is often localhost in .env.local and would
  // break production if it beat AURALINK_BACKEND_URL on Vercel.
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

type VisionAttrs = {
  price_value?: number | null;
  price_display?: string | null;
  price_source?: string | null;
};

type VisionCopy = {
  description?: string;
  bullet_points?: unknown;
};

/** GBP/USD/EUR amounts in listing copy (web PDP snippets often include a price even when the photo has none). */
function parseFirstPriceFromText(text: string): string {
  const s = (text || "").replace(/\s+/g, " ");
  if (!s.trim()) return "";
  const patterns = [
    /£\s*([\d,]+(?:\.\d{1,2})?)/,
    /\$\s*([\d,]+(?:\.\d{1,2})?)/,
    /€\s*([\d,]+(?:\.\d{1,2})?)/,
    /GBP\s*[£]?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /USD\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return String(n);
    }
  }
  return "";
}

/** Vision `price_range_display`, e.g. "385-420" or "£385 - £420" (multi-retailer average). */
function parsePriceRangeDisplay(s: string): string {
  const t = (s || "").trim();
  if (!t) return "";
  const nums = t.replace(/£|\$|€|,/g, " ").match(/[\d.]+/g);
  if (!nums?.length) return "";
  const vals = nums.map((x) => parseFloat(x)).filter((n) => Number.isFinite(n) && n > 0);
  if (!vals.length) return "";
  if (vals.length >= 2) return String((vals[0] + vals[vals.length - 1]) / 2);
  return String(vals[0]);
}

/** Shopee and similar marketplaces require product titles ≥ ~20 characters. */
const MARKETPLACE_LISTING_TITLE_MIN_LEN = 20;

function ensureListingTitleMinLength(
  rawTitle: string,
  visionJson: {
    extraction_copy?: VisionCopy & { seo_title?: string };
    attributes?: Record<string, unknown>;
    tags?: { search_keywords?: unknown };
  }
): string {
  let base = (rawTitle || "").replace(/\s+/g, " ").trim();
  if (base.length >= MARKETPLACE_LISTING_TITLE_MIN_LEN) return base.slice(0, 200);
  const parts: string[] = base ? [base] : [];
  const push = (v: unknown, max = 120) => {
    const s = String(v ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
    if (s.length < 2) return;
    const blob = parts.join(" ").toLowerCase();
    if (blob.includes(s.toLowerCase())) return;
    parts.push(s);
  };
  const attrs = visionJson.attributes || {};
  push(attrs.brand);
  push(attrs.exact_model);
  push(attrs.make);
  push(attrs.product_type);
  push(attrs.color);
  push(attrs.material);
  // Unlike the bullet_points/search_keywords loops below, this had no length check before
  // pushing — so even after brand/type/color already padded the title past the minimum, the
  // description's first sentence still got glued on unconditionally, producing a run-on
  // "title + start of description" string that then got hard-truncated mid-sentence.
  if (parts.join(" ").length < MARKETPLACE_LISTING_TITLE_MIN_LEN) {
    const desc = visionJson.extraction_copy?.description;
    if (typeof desc === "string" && desc.trim()) {
      const first = desc.split(/[.!\n–—;]/)[0]?.trim() || "";
      if (first.length > 4) push(first, 95);
    }
  }
  const bp = visionJson.extraction_copy?.bullet_points;
  if (Array.isArray(bp)) {
    for (const b of bp.slice(0, 4)) {
      if (parts.join(" ").length >= MARKETPLACE_LISTING_TITLE_MIN_LEN) break;
      if (typeof b === "string" && b.trim()) push(b, 85);
    }
  }
  const sk = visionJson.tags && (visionJson.tags as { search_keywords?: unknown }).search_keywords;
  if (Array.isArray(sk)) {
    for (const k of sk) {
      if (parts.join(" ").length >= MARKETPLACE_LISTING_TITLE_MIN_LEN) break;
      if (typeof k === "string" && k.trim()) push(k, 50);
    }
  }
  let out = parts.join(" ").replace(/\s+/g, " ").trim();
  if (out.length < MARKETPLACE_LISTING_TITLE_MIN_LEN) {
    out = `${out} — see description for specifications`.replace(/\s+/g, " ").trim();
  }
  return out.slice(0, 200);
}

function gatherListingPriceText(visionJson: {
  extraction_copy?: VisionCopy;
  price_range_display?: string | null;
}): string {
  const parts: string[] = [];
  const pr = visionJson.price_range_display;
  if (typeof pr === "string" && pr.trim()) parts.push(pr);
  const copy = visionJson.extraction_copy;
  if (copy?.description) parts.push(copy.description);
  if (Array.isArray(copy?.bullet_points)) {
    for (const b of copy.bullet_points) {
      if (typeof b === "string") parts.push(b);
    }
  }
  return parts.join("\n");
}

/**
 * Precedence: structured attributes (incl. web_average) → price_range_display → currency in description/bullets.
 * Do not bail on price_source "not_found" until after text fallbacks — photos often have no sticker price.
 */
function resolvePriceFromVision(visionJson: {
  attributes?: VisionAttrs;
  extraction_copy?: VisionCopy;
  price_range_display?: string | null;
}): string {
  const att = visionJson.attributes || {};
  const src = att.price_source;

  if (src !== "not_found") {
    if (att.price_value != null && typeof att.price_value === "number" && att.price_value > 0) {
      return String(att.price_value);
    }
    if (att.price_display && typeof att.price_display === "string") {
      const match = att.price_display.replace(/[^\d.]/g, "").match(/[\d.]+/);
      if (match && parseFloat(match[0]) > 0) return String(parseFloat(match[0]));
    }
  }

  const fromRange = parsePriceRangeDisplay(String(visionJson.price_range_display || ""));
  if (fromRange) return fromRange;

  const fromText = parseFirstPriceFromText(gatherListingPriceText(visionJson));
  if (fromText) return fromText;

  return "";
}

/**
 * Last-resort price estimate when VLM and web enrichment both return nothing.
 * Uses the product category/title to pick a reasonable secondhand/charity-shop value (GBP).
 */
function fallbackCategoryPrice(visionJson: {
  tags?: { category?: unknown };
  attributes?: { brand?: unknown; product_type?: unknown };
  extraction_copy?: { seo_title?: unknown };
}): string {
  const cat = String(visionJson.tags?.category || "").toLowerCase();
  const title = String(
    (visionJson.extraction_copy as { seo_title?: unknown } | undefined)?.seo_title || ""
  ).toLowerCase();
  const combined = `${cat} ${title}`;

  if (/headphone|speaker|earphone|airpod|earbud|audio/.test(combined)) return "25";
  if (/console|playstation|xbox|nintendo|switch|ps[0-9]/.test(combined)) return "80";
  if (/laptop|macbook|computer|tablet|ipad/.test(combined)) return "120";
  if (/phone|iphone|samsung|smartphone/.test(combined)) return "60";
  if (/camera|lens|dslr/.test(combined)) return "45";
  if (/watch|smartwatch|fitbit/.test(combined)) return "20";
  if (/toy|lego|figure|collectible|blind.?box|funko|game/.test(combined)) return "10";
  if (/trainer|sneaker|shoe|boot/.test(combined)) return "18";
  if (/jacket|coat|hoodie|jumper|knitwear/.test(combined)) return "12";
  if (/jeans|trouser|shorts|skirt|dress/.test(combined)) return "8";
  if (/shirt|t-shirt|top|blouse/.test(combined)) return "5";
  if (/bag|backpack|handbag|purse/.test(combined)) return "12";
  if (/book|novel|textbook/.test(combined)) return "3";
  if (/dvd|blu.?ray|cd|vinyl/.test(combined)) return "3";
  if (/jewellery|jewelry|necklace|bracelet|ring/.test(combined)) return "8";
  if (/tool|drill|power.?tool/.test(combined)) return "15";
  if (/kitchen|cookware|pan|pot/.test(combined)) return "8";
  if (/toy|kids|children|baby/.test(combined)) return "5";
  // Default charity shop estimate for unrecognised categories
  return "5";
}

export async function POST(request: NextRequest) {
  try {
    return await handleSnapPairPush(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/snap-pair/push]", err);
    const h = cors(request);
    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === "development"
            ? `Push failed: ${message}`
            : "Could not save listing after extraction. Try a smaller image or check server logs.",
      },
      { status: 500, headers: h }
    );
  }
}

async function handleSnapPairPush(request: NextRequest) {
  const h = cors(request);
  const useDevMemory = snapPairDevMemoryActive() && !isSnapPairConfigured();
  const supabase = useDevMemory ? null : getSupabaseAdmin();
  if (!useDevMemory) {
    if (!isSnapPairConfigured()) {
      return NextResponse.json({ error: "Snap pair not configured (Supabase + service role)" }, { status: 503, headers: h });
    }
    if (!supabase) {
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500, headers: h });
    }
  }

  let body: {
    session_id?: string;
    image_base64?: string;
    mime_type?: string;
    extra_images?: Array<{ image_base64?: string; mime_type?: string }>;
    /** Public URLs for original (full-res) images uploaded separately (e.g. Supabase Storage). */
    original_image_urls?: string[];
    append_only?: boolean;
  } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: h });
  }
  const sessionId = String(body.session_id || "").trim();
  const imageBase64 = String(body.image_base64 || "").trim();
  const mimeType = String(body.mime_type || "image/jpeg").trim();
  const extraImages = Array.isArray(body.extra_images) ? body.extra_images : [];
  const originalImageUrls = Array.isArray(body.original_image_urls) ? body.original_image_urls : [];
  const appendOnly = !!body.append_only;

  if (!/^[a-f0-9]{12,32}$/i.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400, headers: h });
  }
  if (!imageBase64) {
    return NextResponse.json({ error: "Missing image_base64" }, { status: 400, headers: h });
  }

  /** Always persist scan as data URL for review UI / extension thumb (Postgres `text` holds large payloads). */
  const dataUrl = `data:${mimeType};base64,${imageBase64.replace(/^data:[^;]+;base64,/, "")}`;

  // Append mode: save image(s) to session media without rerunning vision/extraction.
  // This avoids request body limits when multiple base64 images are sent together.
  if (appendOnly) {
    const extraDataUrls: string[] = [];
    for (const e of extraImages) {
      const b64 = String(e?.image_base64 || "").trim();
      if (!b64) continue;
      const mt = String(e?.mime_type || "image/jpeg").trim() || "image/jpeg";
      extraDataUrls.push(`data:${mt};base64,${b64.replace(/^data:[^;]+;base64,/, "")}`);
    }
    const toAppend = [dataUrl, ...extraDataUrls].filter(Boolean);
    const originalToAppend = (originalImageUrls || [])
      .map((u) => String(u || "").trim())
      .filter((u) => /^https?:\/\//i.test(u));

    const appendInto = (curExtra: unknown) => {
      const base =
        curExtra && typeof curExtra === "object" && !Array.isArray(curExtra)
          ? (curExtra as Record<string, unknown>)
          : {};
      const media =
        base.media && typeof base.media === "object" && !Array.isArray(base.media)
          ? (base.media as Record<string, unknown>)
          : {};
      const cur =
        Array.isArray(media.image_urls) ? (media.image_urls as unknown[]).filter((u) => typeof u === "string") : [];
      const set = new Set<string>(cur as string[]);
      for (const u of toAppend) set.add(u);
      const curOrig = Array.isArray((media as Record<string, unknown>).original_image_urls)
        ? ((media as Record<string, unknown>).original_image_urls as unknown[]).filter((u) => typeof u === "string")
        : [];
      const origSet = new Set<string>(curOrig as string[]);
      for (const u of originalToAppend) origSet.add(u);
      return {
        ...base,
        media: {
          ...media,
          image_urls: Array.from(set),
          ...(origSet.size ? { original_image_urls: Array.from(origSet) } : {}),
        },
      };
    };

    const now = new Date().toISOString();

    if (useDevMemory) {
      const prev = devGet(sessionId);
      if (!prev) {
        // If session doesn't exist in dev memory, create a minimal row.
        devUpsert({
          session_id: sessionId,
          title: "",
          description: "",
          price: "",
          image_url: dataUrl,
          listing_extra: { media: { image_urls: [dataUrl] } },
          updated_at: now,
        });
        return NextResponse.json({ ok: true }, { headers: h });
      }
      devUpsert({
        ...prev,
        image_url: prev.image_url || dataUrl,
        listing_extra: appendInto(prev.listing_extra),
        updated_at: now,
      });
      return NextResponse.json({ ok: true }, { headers: h });
    }

    const { data: curRow, error: curErr } = await supabase!
      .from("snap_pair_sessions")
      .select("image_url,listing_extra")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (curErr) {
      console.error("[api/snap-pair/push] append select failed", { sessionId, message: curErr.message });
      return NextResponse.json({ error: curErr.message }, { status: 500, headers: h });
    }
    const curExtra = (curRow as { listing_extra?: unknown } | null)?.listing_extra;
    const nextExtra = appendInto(curExtra);
    const curImageUrl = (curRow as { image_url?: unknown } | null)?.image_url;
    const nextImageUrl =
      typeof curImageUrl === "string" && curImageUrl.trim()
        ? curImageUrl
        : dataUrl;

    const { error: updErr } = await supabase!.from("snap_pair_sessions").upsert(
      {
        session_id: sessionId,
        image_url: nextImageUrl,
        listing_extra: nextExtra,
        updated_at: now,
      },
      { onConflict: "session_id" }
    );
    if (updErr) {
      console.error("[api/snap-pair/push] append upsert failed", { sessionId, message: updErr.message });
      return NextResponse.json({ error: updErr.message }, { status: 500, headers: h });
    }
    return NextResponse.json({ ok: true }, { headers: h });
  }

  const base = backendBase();
  if (!base) {
    return NextResponse.json(
      {
        error:
          "Server misconfigured: set AURALINK_BACKEND_URL to your live backend (e.g. https://<cloud-run-service>).",
      },
      { status: 500, headers: h }
    );
  }
  const visionUrl = `${base}/api/v1/vision/extract`;
  const auth = request.headers.get("authorization");
  const anonId = request.headers.get("x-synclyst-anon-id") || request.headers.get("X-SyncLyst-Anon-Id");
  const visionHeaders: HeadersInit = { "Content-Type": "application/json" };
  if (auth) visionHeaders.Authorization = auth;
  if (anonId) visionHeaders["X-SyncLyst-Anon-Id"] = anonId;

  const visionBody = JSON.stringify({
    image_base64: imageBase64,
    mime_type: mimeType,
    skip_web_enrichment: false,
    extraction_type: "product",
    // gemini-2.5-flash-lite + thinking disabled — ~3-5s vs ~15-20s for the default model on
    // just the core extraction call. Web enrichment (kept on above) still runs at normal
    // speed; this only speeds up the part it controls. Revert by removing this line if real
    // photos show a meaningful accuracy drop.
    fast_mode: true,
  });

  let visionRes: Response;
  try {
    visionRes = await fetch(visionUrl, {
      method: "POST",
      headers: visionHeaders,
      body: visionBody,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[api/snap-pair/push] vision fetch threw", { visionUrl, detail, err });
    const devHint =
      process.env.NODE_ENV === "development"
        ? " From the repo root run `npm run dev:synclyst` (starts API :8000 + Next)."
        : "";
    return NextResponse.json(
      {
        error: `Vision API unreachable at ${visionUrl}. Start the backend (e.g. \`uvicorn app.main:app --host 0.0.0.0 --port 8000\`).${devHint} ${detail}`,
      },
      { status: 502, headers: h }
    );
  }

  const visionText = await visionRes.text();
  let visionJson: { detail?: string; extraction_copy?: unknown; attributes?: unknown } = {};
  try {
    visionJson = visionText ? JSON.parse(visionText) : {};
  } catch {
    return NextResponse.json(
      {
        error: `Vision API returned non-JSON (HTTP ${visionRes.status}): ${visionText.slice(0, 240)}`,
      },
      { status: 502, headers: h }
    );
  }

  if (!visionRes.ok) {
    const status = visionRes.status >= 400 ? visionRes.status : 502;
    const body = visionJson as {
      detail?: string;
      scans_limit?: number;
      quota_window?: string;
      bonus_credits?: number;
    };
    if (status === 402) {
      return NextResponse.json(
        {
          error: body.detail || "Scan limit reached.",
          scans_limit: body.scans_limit,
          quota_window: body.quota_window,
          bonus_credits: body.bonus_credits,
        },
        { status, headers: h }
      );
    }
    return NextResponse.json(
      { error: body.detail || "Vision extract failed" },
      { status, headers: h }
    );
  }

  const copy = (visionJson as { extraction_copy?: { seo_title?: unknown; description?: unknown } }).extraction_copy;
  const rawTitle = asTrimmedString(copy?.seo_title) || "Untitled";
  const title = ensureListingTitleMinLength(rawTitle, visionJson as Parameters<typeof ensureListingTitleMinLength>[1]);
  const description = asTrimmedString(
    descriptionFromVisionExtraction(visionJson as Parameters<typeof descriptionFromVisionExtraction>[0])
  );
  const price =
    resolvePriceFromVision(visionJson as Parameters<typeof resolvePriceFromVision>[0]) ||
    fallbackCategoryPrice(visionJson as Parameters<typeof fallbackCategoryPrice>[0]);

  const extraDataUrls: string[] = [];
  for (const e of extraImages) {
    const b64 = String(e?.image_base64 || "").trim();
    if (!b64) continue;
    const mt = String(e?.mime_type || "image/jpeg").trim() || "image/jpeg";
    extraDataUrls.push(`data:${mt};base64,${b64.replace(/^data:[^;]+;base64,/, "")}`);
  }

  const mediaPatch = {
    media: {
      image_urls: [dataUrl, ...extraDataUrls],
    },
  };
  const originalPatch = {
    media: {
      original_image_urls: (originalImageUrls || [])
        .map((u) => String(u || "").trim())
        .filter((u) => /^https?:\/\//i.test(u)),
    },
  };

  const shopifyPatch = buildShopifyListingExtraFromVision(visionJson as Parameters<typeof buildShopifyListingExtraFromVision>[0]);
  const ebayPatch = buildEbayListingExtraFromVision(visionJson as Parameters<typeof buildEbayListingExtraFromVision>[0]);
  const vintedPatch = buildVintedListingExtraFromVision(visionJson as Parameters<typeof buildVintedListingExtraFromVision>[0]);
  const shopeePatch = buildShopeeListingExtraFromVision(visionJson as Parameters<typeof buildShopeeListingExtraFromVision>[0]);
  const etsyPatch = buildEtsyListingExtraFromVision(visionJson as Parameters<typeof buildEtsyListingExtraFromVision>[0]);
  const depopPatch = buildDepopListingExtraFromVision(visionJson as Parameters<typeof buildDepopListingExtraFromVision>[0]);

  if (useDevMemory) {
    const prev = devGet(sessionId);
    let mergedExtra = mergeShopifyIntoListingExtra(prev?.listing_extra ?? {}, shopifyPatch);
    mergedExtra = mergeEbayIntoListingExtra(mergedExtra, ebayPatch);
    mergedExtra = mergeVintedIntoListingExtra(mergedExtra, vintedPatch);
    mergedExtra = mergeShopeeIntoListingExtra(mergedExtra, shopeePatch);
    mergedExtra = mergeEtsyIntoListingExtra(mergedExtra, etsyPatch);
    mergedExtra = mergeDepopIntoListingExtra(mergedExtra, depopPatch);
    mergedExtra = { ...(mergedExtra || {}), ...(mediaPatch as unknown as Record<string, unknown>) };
    // Preserve original URLs when provided (dev-memory can't store blobs; expects http(s) URLs).
    if ((originalPatch.media.original_image_urls || []).length) {
      const m = (mergedExtra.media && typeof mergedExtra.media === "object" && !Array.isArray(mergedExtra.media))
        ? (mergedExtra.media as Record<string, unknown>)
        : {};
      const cur = Array.isArray(m.original_image_urls) ? m.original_image_urls.filter((u) => typeof u === "string") : [];
      const set = new Set<string>(cur as string[]);
      for (const u of originalPatch.media.original_image_urls) set.add(u);
      mergedExtra = { ...mergedExtra, media: { ...m, original_image_urls: Array.from(set) } };
    }
    devUpsert({
      session_id: sessionId,
      title,
      description,
      price,
      image_url: dataUrl,
      listing_extra: mergedExtra,
      updated_at: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true, title, price }, { headers: h });
  }

  const { data: prevRow } = await supabase!
    .from("snap_pair_sessions")
    .select("listing_extra")
    .eq("session_id", sessionId)
    .maybeSingle();

  let mergedListingExtra = mergeShopifyIntoListingExtra(
    (prevRow as { listing_extra?: unknown } | null)?.listing_extra ?? {},
    shopifyPatch
  );
  mergedListingExtra = mergeEbayIntoListingExtra(mergedListingExtra, ebayPatch);
  mergedListingExtra = mergeVintedIntoListingExtra(mergedListingExtra, vintedPatch);
  mergedListingExtra = mergeShopeeIntoListingExtra(mergedListingExtra, shopeePatch);
  mergedListingExtra = mergeEtsyIntoListingExtra(mergedListingExtra, etsyPatch);
  mergedListingExtra = mergeDepopIntoListingExtra(mergedListingExtra, depopPatch);
  mergedListingExtra = { ...(mergedListingExtra || {}), ...(mediaPatch as unknown as Record<string, unknown>) };
  if ((originalPatch.media.original_image_urls || []).length) {
    const base = mergedListingExtra && typeof mergedListingExtra === "object" && !Array.isArray(mergedListingExtra)
      ? (mergedListingExtra as Record<string, unknown>)
      : {};
    const media =
      base.media && typeof base.media === "object" && !Array.isArray(base.media)
        ? (base.media as Record<string, unknown>)
        : {};
    const cur = Array.isArray(media.original_image_urls)
      ? (media.original_image_urls as unknown[]).filter((u) => typeof u === "string")
      : [];
    const set = new Set<string>(cur as string[]);
    for (const u of originalPatch.media.original_image_urls) set.add(u);
    mergedListingExtra = { ...base, media: { ...media, original_image_urls: Array.from(set) } };
  }

  const { error } = await supabase!.from("snap_pair_sessions").upsert(
    {
      session_id: sessionId,
      title,
      description,
      price,
      image_url: dataUrl,
      listing_extra: mergedListingExtra,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id" }
  );

  if (error) {
    console.error("[api/snap-pair/push] final upsert failed", {
      sessionId,
      message: error.message,
      name: (error as unknown as { name?: unknown }).name,
      cause: (error as unknown as { cause?: unknown }).cause,
      supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_PROJECT_URL,
    });
    return NextResponse.json({ error: error.message }, { status: 500, headers: h });
  }

  return NextResponse.json({ ok: true, title, price }, { headers: h });
}
