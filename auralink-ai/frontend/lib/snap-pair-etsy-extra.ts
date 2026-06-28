/**
 * Vision extract → listing_extra.etsy for Magic Fill + extension-review (Etsy listing editor).
 *
 * Field map ↔ Etsy seller “Create listing” UI (Add a listing):
 * - Photo & video: session hero + `additional_images` (not duplicated here).
 * - Category: `category_search`, `category_leaf`, `category_breadcrumb`.
 * - Item type / when made: `item_type`, `when_made`.
 * - Item details: `title` (session), description (session).
 * - Attributes: `tags`, `brand`, `materials_hint`, `primary_color`, `size_scale`.
 * - Price & inventory: price/qty/SKU on session + `quantity`, `sku`; `domestic_global_pricing` toggle.
 * - How it’s made: `who_made`, `what_is_it`, `how_produced`, `production_tools`.
 * - Settings: `renewal`, `shop_section`.
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

function splitCategoryLeafAndTrail(raw: string): { leaf: string; breadcrumb: string } {
  const s = (raw || "").replace(/\s+/g, " ").trim();
  if (!s) return { leaf: "", breadcrumb: "" };
  const parts = s.split(/(?:\s*>\s*|\s*›\s*)/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return { leaf: parts[0] || "", breadcrumb: s };
  return { leaf: parts[parts.length - 1], breadcrumb: s };
}

/**
 * Vision → listing_extra.etsy (same extraction pipeline as eBay/Vinted).
 */
export function buildEtsyListingExtraFromVision(visionJson: VisionPayload): Record<string, unknown> {
  const copy = visionJson.extraction_copy || {};
  const att = visionJson.attributes || {};
  const tags = visionJson.tags || {};

  const categoryFromTags = (tags.category && String(tags.category).trim()) || "";
  const categoryFromAttrs = att.category ? String(att.category).trim() : "";
  const kw = Array.isArray(tags.search_keywords)
    ? tags.search_keywords.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const categoryFromKeywords = kw.length ? kw.slice(0, 8).join(" > ") : "";
  const productType = (att.product_type && String(att.product_type).trim()) || "";
  const categoryRaw = categoryFromTags || categoryFromAttrs || productType || categoryFromKeywords;
  const { leaf, breadcrumb } = splitCategoryLeafAndTrail(categoryRaw);

  const tagsComma = kw.slice(0, 13).join(", ");
  const brandRaw = (att.brand && String(att.brand).trim()) || "";
  const brand = shouldUseExtractedBrandForMarketplaces(visionJson) ? brandRaw : "";
  const materials =
    Array.isArray(att.detected_materials) && att.detected_materials.length
      ? att.detected_materials
          .map((m) => String(m).trim())
          .filter(Boolean)
          .slice(0, 5)
          .join(", ")
      : att.material
        ? String(att.material).trim()
        : "";

  const category_search = leaf || breadcrumb.split(/\s*>\s*/)[0] || productType || "";

  /** Etsy listing title: 1–140 characters (Shop Manager validation). */
  const ETSY_TITLE_MAX = 140;
  const titleFromSeo = copy.seo_title != null ? String(copy.seo_title).trim() : "";
  const color =
    (att.color && String(att.color).trim()) ||
    (Array.isArray(att.detected_colors) ? att.detected_colors.map((c) => String(c).trim()).filter(Boolean)[0] : "") ||
    "";

  const titleFallbackParts = [
    brand,
    productType,
    color,
    materials,
    leaf && leaf.toLowerCase() !== productType.toLowerCase() ? leaf : "",
  ]
    .map((x) => String(x || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Etsy requires a non-empty title; when vision doesn't return seo_title, synthesize a reasonable one.
  const synthesized = titleFallbackParts.join(" ").trim();
  const titleRaw = titleFromSeo || synthesized;
  const title = titleRaw ? titleRaw.replace(/\s+/g, " ").trim().slice(0, ETSY_TITLE_MAX) : "";

  const sizeFromAttrs =
    (att.size && String(att.size).trim()) ||
    (Array.isArray(att.detected_sizes) && att.detected_sizes.length
      ? String(att.detected_sizes[0]).trim()
      : "") ||
    "";

  const skuFromAttrs =
    (att.sku && String(att.sku).trim()) ||
    (att.model_number && String(att.model_number).trim()) ||
    "";
  const descBlob = `${String(copy.description || "").toLowerCase()} ${titleRaw.toLowerCase()}`;
  const mentionsAi = /\b(ai generated|ai generator|midjourney|dall[\s-]?e|chatgpt|stable diffusion|generative)\b/i.test(
    descBlob
  );
  const production_tools = mentionsAi ? "ai" : "handheld";

  let how_produced = "scratch";
  if (/\bcurated\b|\bgift\s*basket\b|\bset\s+of\b|\bpre[-\s]?made\b|\bvintage\b|\bpreloved\b|\bsecond\s*hand\b|\bused\b/i.test(descBlob)) {
    how_produced = "curated";
  } else if (/\bassembled\b|\bkit\b|\bparts\b/i.test(descBlob)) {
    how_produced = "assembled";
  } else if (/\balter(ed)?\b|\bupcycle/i.test(descBlob)) {
    how_produced = "altered";
  } else if (/\bnatural\b|\braw\s+(material|wood|stone)\b/i.test(descBlob)) {
    how_produced = "natural";
  }

  const out: Record<string, unknown> = {
    title: title || undefined,
    category_leaf: leaf || undefined,
    category_breadcrumb: breadcrumb || undefined,
    category_search: category_search || undefined,
    tags: tagsComma || undefined,
    brand: brand || undefined,
    materials_hint: materials || undefined,
    primary_color: color || undefined,
    size_scale: sizeFromAttrs || undefined,
    quantity: "1",
    item_type: "physical",
    who_made: "i_did",
    what_is_it: "finished",
    renewal: "automatic",
    how_produced,
    production_tools,
    // Etsy requires this for most categories; "Made to order" is broadly safe for new items.
    when_made: "Made to order",
    sku: skuFromAttrs || undefined,
    shop_section: "",
  };

  return Object.fromEntries(Object.entries(out).filter(([, v]) => !isEmptyVal(v)));
}

/** Without this, a later re-extraction in the same session (e.g. a different photo reusing
 * the same session_id) could never overwrite a stale title/category/brand from an earlier,
 * unrelated scan — matches the EBAY_ALWAYS_OVERWRITE / SHOPIFY_ALWAYS_OVERWRITE safeguard. */
const ETSY_ALWAYS_OVERWRITE = new Set([
  "title",
  "category_leaf",
  "category_breadcrumb",
  "category_search",
  "brand",
  "tags",
]);

export function mergeEtsyIntoListingExtra(
  prevListingExtra: unknown,
  incomingEtsy: Record<string, unknown>
): JsonObject {
  const root: JsonObject = isPlainObject(prevListingExtra) ? { ...(prevListingExtra as JsonObject) } : {};
  const prevRaw = root.etsy;
  const prevE: JsonObject = isPlainObject(prevRaw) ? { ...(prevRaw as JsonObject) } : {};

  for (const [k, v] of Object.entries(incomingEtsy)) {
    if (isEmptyVal(v)) continue;
    const cur = prevE[k];
    if (!ETSY_ALWAYS_OVERWRITE.has(k) && !isEmptyVal(cur)) continue;
    prevE[k] = v;
  }

  root.etsy = prevE;
  return root;
}
