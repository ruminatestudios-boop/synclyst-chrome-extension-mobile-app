/**
 * Vision extract → listing_extra.ebay for Magic Fill + extension-review (eBay “Complete your listing”).
 * Aligns with seller flow: category, item specifics, condition, pricing, shipping, preferences.
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

function guessBarcodeFromOcr(snippets: unknown): string {
  if (!Array.isArray(snippets)) return "";
  for (const s of snippets) {
    if (typeof s !== "string") continue;
    const digits = s.replace(/\D/g, "");
    if (/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(digits)) return digits;
  }
  return "";
}

/** Split “A > B > C” into breadcrumb + leaf label for eBay’s category summary row. */
function splitCategoryLeafAndTrail(raw: string): { leaf: string; breadcrumb: string } {
  const s = (raw || "").replace(/\s+/g, " ").trim();
  if (!s) return { leaf: "", breadcrumb: "" };
  const parts = s.split(/(?:\s*>\s*|\s*›\s*)/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return { leaf: parts[0] || "", breadcrumb: s };
  return { leaf: parts[parts.length - 1], breadcrumb: s };
}

function guessDepartment(category: string, title: string): string {
  const blob = `${category} ${title}`.toLowerCase();
  if (/\bwomen'?s\b|\bfor women\b|\bwomen\b/.test(blob) && !/\bmen'?s\b|\bmen\b/.test(blob)) return "Women";
  if (/\bmen'?s\b|\bfor men\b|\bmen\b/.test(blob)) return "Men";
  if (/\bkids?\b|\bchildren\b|\bboys\b|\bgirls\b/.test(blob)) return "Kids";
  return "";
}

function gramsToLbOz(g: number): { lbs: string; oz: string } {
  if (!Number.isFinite(g) || g <= 0) return { lbs: "", oz: "" };
  const totalOz = g / 28.349523125;
  const lbs = Math.floor(totalOz / 16);
  const oz = Math.round(totalOz - lbs * 16);
  return { lbs: lbs > 0 ? String(lbs) : "", oz: oz > 0 ? String(oz) : oz === 0 && lbs === 0 ? "1" : String(oz) };
}

function packageWeightFromAttrs(att: NonNullable<VisionPayload["attributes"]>): { lbs: string; oz: string } {
  const wg = att.weight_grams;
  if (typeof wg === "number" && wg > 0) return gramsToLbOz(wg);
  const w = att.weight && String(att.weight).trim();
  if (!w) return { lbs: "", oz: "" };
  const low = w.toLowerCase();
  const numMatch = w.match(/[\d.]+/);
  const num = numMatch ? parseFloat(numMatch[0]) : NaN;
  if (!Number.isFinite(num) || num <= 0) return { lbs: "", oz: "" };
  if (/\b(lb|lbs|pound)\b/.test(low)) return { lbs: String(Math.round(num * 10) / 10), oz: "" };
  if (/\boz\b/.test(low)) return { lbs: "", oz: String(Math.round(num * 10) / 10) };
  if (/\b(g|gram|grams)\b/.test(low)) return gramsToLbOz(num);
  if (/\bkg\b|kilo/.test(low)) return gramsToLbOz(num * 1000);
  return { lbs: "", oz: "" };
}

function parseDimensionsToInches(dim: string | null | undefined): { l: string; w: string; h: string } {
  if (!dim || !String(dim).trim()) return { l: "", w: "", h: "" };
  const nums = String(dim).match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return { l: "", w: "", h: "" };
  return { l: nums[0], w: nums[1], h: nums[2] || "" };
}

function humanCondition(c: string | null | undefined): string {
  if (!c || !String(c).trim()) return "";
  return String(c).trim().replace(/_/g, " ");
}

function sizeFromTitle(title: string): string {
  const t = (title || "").trim();
  if (!t) return "";
  const m = t.match(/\b(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL)\b/i);
  return m ? String(m[1]).toUpperCase() : "";
}

/**
 * Prefer `extraction_copy.description`; fall back to UCP Fact–Feel–Proof, then bullets.
 * Ensures session + eBay listing text populate when the model returns structured copy only.
 */
export function descriptionFromVisionExtraction(visionJson: VisionPayload): string {
  const copy = visionJson.extraction_copy || {};
  const direct = copy.description != null ? String(copy.description).trim() : "";
  if (direct) return direct;

  const ffp = (
    copy as {
      description_fact_feel_proof?: { fact?: string | null; feel?: string | null; proof?: string | null } | null;
    }
  ).description_fact_feel_proof;
  if (ffp && typeof ffp === "object") {
    const parts = [ffp.fact, ffp.feel, ffp.proof]
      .map((x) => (x != null ? String(x).trim() : ""))
      .filter(Boolean);
    if (parts.length) return parts.join("\n\n");
  }

  const bullets = Array.isArray(copy.bullet_points)
    ? copy.bullet_points
        .map((x) => (typeof x === "string" ? x.trim() : String(x || "").trim()))
        .filter(Boolean)
    : [];
  return bullets.length ? bullets.join("\n\n") : "";
}

/**
 * Vision → listing_extra.ebay (same extraction pipeline as Shopify/Vinted).
 */
export function buildEbayListingExtraFromVision(visionJson: VisionPayload): Record<string, unknown> {
  const copy = visionJson.extraction_copy || {};
  const att = visionJson.attributes || {};
  const tags = visionJson.tags || {};

  const title = (copy.seo_title && String(copy.seo_title).trim()) || "";
  const itemDescriptionRaw = descriptionFromVisionExtraction(visionJson);
  const categoryFromTags = (tags.category && String(tags.category).trim()) || "";
  const categoryFromAttrs = att.category ? String(att.category).trim() : "";
  const kw = Array.isArray(tags.search_keywords)
    ? tags.search_keywords.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const categoryFromKeywords = kw.length ? kw.slice(0, 6).join(" > ") : "";
  const productType = (att.product_type && String(att.product_type).trim()) || "";
  const categoryRaw =
    categoryFromTags || categoryFromAttrs || productType || categoryFromKeywords;
  const { leaf, breadcrumb } = splitCategoryLeafAndTrail(categoryRaw);

  const brandRaw = (att.brand && String(att.brand).trim()) || "";
  const brand = shouldUseExtractedBrandForMarketplaces(visionJson) ? brandRaw : "";
  const sizes = Array.isArray(att.detected_sizes)
    ? att.detected_sizes.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const sizeFromAttr = att.size != null ? String(att.size).trim() : "";
  const size =
    sizes[0] ||
    sizeFromAttr ||
    sizeFromTitle(title) ||
    "";
  const colors =
    Array.isArray(att.detected_colors) && att.detected_colors.length
      ? att.detected_colors.map((c) => String(c).trim()).filter(Boolean)
      : att.color
        ? String(att.color)
            .split(/[,;/]/)
            .map((c) => c.trim())
            .filter(Boolean)
        : [];
  const color = colors[0] || "";
  const department = guessDepartment(categoryRaw, title);
  const upc = guessBarcodeFromOcr(visionJson.raw_ocr_snippets);
  const condition = humanCondition(att.condition);
  const dims = parseDimensionsToInches(att.dimensions ? String(att.dimensions) : "");
  const { lbs, oz } = packageWeightFromAttrs(att);

  // eBay requires a non-empty description; if vision copy is empty, synthesize a safe default.
  const synthParts: string[] = [];
  const synthPush = (label: string, val: string) => {
    const v = String(val || "").trim();
    if (!v) return;
    synthParts.push(`${label}: ${v}`);
  };
  if (title) synthParts.push(title);
  synthPush("Brand", brand);
  synthPush("Color", color);
  synthPush("Size", size);
  synthPush("Condition", condition);
  if (breadcrumb) synthPush("Category", breadcrumb);
  if (lbs || oz) synthPush("Package weight", [lbs && `${lbs} lb`, oz && `${oz} oz`].filter(Boolean).join(" "));
  const itemDescriptionSynth = synthParts.length
    ? `${synthParts.join("\n")}\n\nMessage me with any questions.`
    : "Message me with any questions.";
  const itemDescription =
    itemDescriptionRaw.trim() ||
    itemDescriptionSynth;

  const out: Record<string, unknown> = {
    item_description: itemDescription || undefined,
    category_leaf: leaf || undefined,
    category_breadcrumb: breadcrumb || undefined,
    brand: brand || undefined,
    size: size || undefined,
    color: color || undefined,
    colors: colors.length ? colors.slice(0, 5) : undefined,
    department: department || undefined,
    upc: upc || undefined,
    item_type: productType || undefined,
    condition: condition || undefined,
    // Prefer Buy It Now (fixed price) by default; auctions increase listing friction.
    pricing_format: "buy_it_now",
    auction_duration_days: "7",
    quantity: "1",
    package_weight_lbs: lbs || undefined,
    package_weight_oz: oz || undefined,
    package_length_in: dims.l || undefined,
    package_width_in: dims.w || undefined,
    package_height_in: dims.h || undefined,
  };

  return Object.fromEntries(Object.entries(out).filter(([, v]) => !isEmptyVal(v)));
}

export function mergeEbayIntoListingExtra(
  prevListingExtra: unknown,
  incomingEbay: Record<string, unknown>
): JsonObject {
  const root: JsonObject = isPlainObject(prevListingExtra) ? { ...(prevListingExtra as JsonObject) } : {};
  const prevRaw = root.ebay;
  const prevE: JsonObject = isPlainObject(prevRaw) ? { ...(prevRaw as JsonObject) } : {};

  for (const [k, v] of Object.entries(incomingEbay)) {
    if (isEmptyVal(v)) continue;
    const cur = prevE[k];
    if (!isEmptyVal(cur)) continue;
    prevE[k] = v;
  }

  root.ebay = prevE;
  return root;
}
