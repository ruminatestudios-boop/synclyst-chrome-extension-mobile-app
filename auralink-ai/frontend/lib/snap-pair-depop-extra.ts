/**
 * Vision extract → listing_extra.depop for Magic Fill + extension-review (Depop “List an item”).
 * Condition labels must match Depop’s dropdown: Brand new | Like new | Used - * (see extension mapper).
 */

import { shouldUseExtractedBrandForMarketplaces, type VisionPayload } from "./snap-pair-shopify-extra";

function isEmptyVal(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string" && !v.trim()) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) return true;
  return false;
}

type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const DEPOP_CONDITION_VALUES = [
  "Brand new",
  "Like new",
  "Used - Excellent",
  "Used - Good",
  "Used - Fair",
] as const;

/** Aligns with extension `normalizeDepopConditionLabel` / extension-review `normalizeDepopConditionForSelect`. */
export function normalizeDepopConditionString(raw: string): string {
  const s = raw != null ? String(raw).trim() : "";
  if (!s) return "";
  if ((DEPOP_CONDITION_VALUES as readonly string[]).includes(s)) return s;
  const lower = s.toLowerCase().replace(/\s+/g, " ");
  /** Vision / UCP enums use underscores: new, like_new, good, fair, for_parts */
  const semanticKey = lower.replace(/_/g, " ").trim();
  const semantic: Record<string, string> = {
    new: "Brand new",
    "like new": "Like new",
    good: "Used - Good",
    fair: "Used - Fair",
    "for parts": "Used - Fair",
  };
  if (semantic[semanticKey]) return semantic[semanticKey];
  const exact: Record<string, string> = {
    "brand new": "Brand new",
    "like new": "Like new",
    "used - excellent": "Used - Excellent",
    "used excellent": "Used - Excellent",
    "used - good": "Used - Good",
    "used good": "Used - Good",
    "used - fair": "Used - Fair",
    "used fair": "Used - Fair",
    new: "Brand new",
    nwt: "Brand new",
    bnwt: "Brand new",
    deadstock: "Brand new",
    excellent: "Used - Excellent",
    good: "Used - Good",
    fair: "Used - Fair",
  };
  if (exact[lower]) return exact[lower];
  if (lower.includes("like new")) return "Like new";
  if (lower.includes("new with tags") || lower.includes("brand new")) return "Brand new";
  if (lower.includes("used - excellent") || lower.includes("used excellent")) return "Used - Excellent";
  if (lower.includes("used - good") || /^used good$/i.test(s.trim())) return "Used - Good";
  if (lower.includes("used - fair") || lower.includes("used fair")) return "Used - Fair";
  if (/\b(excellent|mint|great)\b/i.test(lower) && !/good|fair/.test(lower)) return "Used - Excellent";
  if (/\bvery\s+good\b/i.test(lower)) return "Used - Excellent";
  if (/\b(satisfactory|acceptable)\b/i.test(lower)) return "Used - Fair";
  return "";
}

/** Heuristic when attributes.condition is empty — mirrors `inferDepopConditionFromScan` in content-script. */
function inferDepopConditionFromBlob(text: string): string {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return "Used - Good";

  if (
    /\b(bnwt|nwt\b|new with tags|brand new|deadstock|tags attached|unworn with tags|sealed in box)\b/i.test(text)
  ) {
    return "Brand new";
  }
  if (/\b(like new|worn once|worn twice|pristine|barely worn|as new)\b/i.test(text)) {
    return "Like new";
  }
  if (
    /\b(heavy wear|major flaw|holes?|ripped|torn|stains?|damaged|well worn|poor condition|significant wear)\b/i.test(
      text
    )
  ) {
    return "Used - Fair";
  }
  if (/used\s*-\s*excellent|used\s+excellent\b/i.test(text)) return "Used - Excellent";
  if (/used\s*-\s*good\b|used\s+good\b/i.test(text)) return "Used - Good";
  if (/used\s*-\s*fair|used\s+fair\b/i.test(text)) return "Used - Fair";

  if (/\b(excellent(\s+condition)?|mint(\s+condition)?|great condition|superb|minimal wear|9\s*\/\s*10)\b/i.test(t)) {
    return "Used - Excellent";
  }
  if (/\b(good(\s+condition)?|good used|light wear|lightly worn|8\s*\/\s*10|7\s*\/\s*10)\b/i.test(t)) {
    return "Used - Good";
  }
  if (/\b(fair(\s+condition)?|visible wear|6\s*\/\s*10|some flaws)\b/i.test(t)) {
    return "Used - Fair";
  }
  if (/\bpreloved\b|\bthrifted\b|\bsecond[\s-]?hand\b/i.test(t)) {
    return "Used - Good";
  }
  return "Used - Good";
}

const DEPOP_STYLE_LABELS = [
  "Streetwear",
  "Vintage",
  "Y2K",
  "Grunge",
  "Boho",
  "Minimal",
  "Cute",
  "Goth",
  "Cottagecore",
  "Dark Academia",
  "Clean Girl",
  "Sportswear",
  "Casual",
  "Formal",
  "Chic",
  "Retro",
  "Indie",
  "Designer",
] as const;

/** Up to 3 style tags for listing_extra.depop.style (comma-separated, Magic Fill). */
function inferDepopStylesFromBlob(text: string): string {
  const t = (text || "").toLowerCase();
  const out: string[] = [];
  const add = (lab: string) => {
    if (out.length >= 3) return;
    if (!out.includes(lab)) out.push(lab);
  };
  if (/\b(streetwear|street\s*wear|hypebeast|supreme)\b/.test(t)) add("Streetwear");
  if (/\b(y2k|2000s|noughties)\b/.test(t)) add("Y2K");
  if (/\b(vintage|retro|thrifted)\b/.test(t)) add("Vintage");
  if (/\b(grunge|punk)\b/.test(t)) add("Grunge");
  if (/\b(boho|bohemian)\b/.test(t)) add("Boho");
  if (/\b(minimal|minimalist)\b/.test(t)) add("Minimal");
  if (/\b(cute|kawaii)\b/.test(t)) add("Cute");
  if (/\b(goth|gothic)\b/.test(t)) add("Goth");
  if (/\bcottagecore\b/.test(t)) add("Cottagecore");
  if (/\bdark\s*academia\b/.test(t)) add("Dark Academia");
  if (/\bclean\s*girl\b/.test(t)) add("Clean Girl");
  if (/\b(sport|athletic|gym|athleisure)\b/.test(t)) add("Sportswear");
  if (/\b(formal|office|work\s*wear)\b/.test(t)) add("Formal");
  if (/\b(chic|elegant)\b/.test(t)) add("Chic");
  if (/\b(indie|alternative)\b/.test(t)) add("Indie");
  if (/\b(designer|luxury|runway)\b/.test(t)) add("Designer");
  if (/\b(casual|everyday|basic)\b/.test(t)) add("Casual");
  if (!out.length) add("Casual");
  return out.join(", ");
}

/**
 * Vision → listing_extra.depop (category/brand mirror Vinted-style hints; condition is Depop-specific).
 */
export function buildDepopListingExtraFromVision(visionJson: VisionPayload): Record<string, unknown> {
  const copy = visionJson.extraction_copy || {};
  const att = visionJson.attributes || {};
  const tags = visionJson.tags || {};

  const categoryFromTags = (tags.category && String(tags.category).trim()) || "";
  const categoryFromAttrs = att.category ? String(att.category).trim() : "";
  const kw = Array.isArray(tags.search_keywords)
    ? tags.search_keywords.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const categoryFromKeywords = kw.length ? kw.slice(0, 5).join(", ") : "";
  const productType = (att.product_type && String(att.product_type).trim()) || "";
  const category = categoryFromTags || categoryFromAttrs || productType || categoryFromKeywords;

  const brandRaw =
    (att.brand && String(att.brand).trim()) ||
    (att.make && String(att.make).trim()) ||
    "";
  const brand = shouldUseExtractedBrandForMarketplaces(visionJson) ? brandRaw : "";

  const sizeFromDetected =
    Array.isArray(att.detected_sizes) && att.detected_sizes.length
      ? String(att.detected_sizes[0] ?? "").trim()
      : "";
  const sizeFromAttr =
    (att.size != null && String(att.size).trim()) ||
    sizeFromDetected ||
    "";

  const condFromAttr = normalizeDepopConditionString(att.condition != null ? String(att.condition) : "");
  const blob = [
    copy.seo_title && String(copy.seo_title),
    copy.description && String(copy.description),
    categoryFromTags,
  ]
    .filter(Boolean)
    .join(" \n ");
  const condition = condFromAttr || inferDepopConditionFromBlob(blob);
  const styleFromBlob = inferDepopStylesFromBlob(blob);
  const styleCanon = styleFromBlob
    .split(",")
    .map((x) => x.trim())
    .filter((x) => (DEPOP_STYLE_LABELS as readonly string[]).includes(x))
    .slice(0, 3)
    .join(", ");

  const out: Record<string, unknown> = {
    category: category || undefined,
    brand: brand || undefined,
    size: sizeFromAttr || undefined,
    condition: condition || undefined,
    style: styleCanon || undefined,
  };

  return Object.fromEntries(Object.entries(out).filter(([, v]) => !isEmptyVal(v)));
}

/** Without this, a later re-extraction in the same session (e.g. a different photo reusing
 * the same session_id) could never overwrite a stale category/brand from an earlier, unrelated
 * scan — matches the EBAY_ALWAYS_OVERWRITE / SHOPIFY_ALWAYS_OVERWRITE safeguard. */
const DEPOP_ALWAYS_OVERWRITE = new Set(["category", "brand"]);

export function mergeDepopIntoListingExtra(
  prevListingExtra: unknown,
  incomingDepop: Record<string, unknown>
): JsonObject {
  const root: JsonObject = isPlainObject(prevListingExtra) ? { ...(prevListingExtra as JsonObject) } : {};
  const prevRaw = root.depop;
  const prevD: JsonObject = isPlainObject(prevRaw) ? { ...(prevRaw as JsonObject) } : {};

  for (const [k, v] of Object.entries(incomingDepop)) {
    if (isEmptyVal(v)) continue;
    const cur = prevD[k];
    if (!DEPOP_ALWAYS_OVERWRITE.has(k) && !isEmptyVal(cur)) continue;
    prevD[k] = v;
  }

  root.depop = prevD;
  return root;
}
