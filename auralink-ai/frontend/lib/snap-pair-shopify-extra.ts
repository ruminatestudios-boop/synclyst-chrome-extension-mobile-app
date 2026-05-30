/**
 * Builds listing_extra.shopify from vision extract JSON (snap-pair push).
 * Only fills blanks when merged into an existing session — never overwrites user edits.
 */

export type VisionTags = { category?: string | null; search_keywords?: string[] | null };
export type VisionAttrs = {
  brand?: string | null;
  /** Some model responses place category on attributes instead of tags. */
  category?: string | null;
  product_type?: string | null;
  exact_model?: string | null;
  /** Stock keeping unit / merchant SKU (when model returns it). */
  sku?: string | null;
  /** Alternative sku-like field some providers emit. */
  model_number?: string | null;
  make?: string | null;
  weight?: string | null;
  weight_grams?: number | null;
  weight_source?: string | null;
  price_display?: string | null;
  material?: string | null;
  color?: string | null;
  detected_colors?: string[] | null;
  detected_sizes?: string[] | null;
  /** e.g. new, like_new, good — forwarded to marketplaces that expose condition. */
  condition?: string | null;
  /** Garment size when the model returns it explicitly (Depop / fills). */
  size?: string | null;
  /** Free-text dimensions e.g. "50x70 cm" — Vinted maps to measurement fields when parsable. */
  dimensions?: string | null;
  material_composition?: string | null;
  detected_materials?: string[] | null;
  /** Garment / decor hints for Etsy item specifics when the model returns them. */
  pattern?: string | null;
  sleeve_length?: string | null;
};
export type VisionCopy = {
  seo_title?: string | null;
  description?: string | null;
  bullet_points?: unknown[] | null;
};

export type VisionPayload = {
  extraction_copy?: VisionCopy | null;
  attributes?: VisionAttrs | null;
  tags?: VisionTags | null;
  raw_ocr_snippets?: unknown;
  /** When present, only `brand: "high"` authorizes marketplace brand/vendor fields. */
  confidence_per_field?: Record<string, unknown> | null;
};

/**
 * Use extracted `attributes.brand` in marketplace listing_extra only when the model
 * marks brand confidence as `high`. Missing `confidence_per_field` / missing `brand`
 * key keeps legacy behaviour (still use the string).
 */
export function shouldUseExtractedBrandForMarketplaces(visionJson: VisionPayload): boolean {
  const raw = visionJson.confidence_per_field;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return true;
  if (!Object.prototype.hasOwnProperty.call(raw, "brand")) return true;
  const b = (raw as Record<string, unknown>).brand;
  if (b == null) return false;
  const s = String(b).trim().toLowerCase();
  /** Treat medium / good as usable — only suppress clearly low-confidence labels. */
  if (s === "high" || s === "medium" || s === "med" || s === "good" || s === "yes") return true;
  if (s === "low" || s === "generic" || s === "unknown" || s === "none" || s === "no") return false;
  return true;
}

const SEO_META_MAX = 155;

function clipMeta(text: string, max = SEO_META_MAX): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trim();
}

function compareAtFromPriceDisplay(pd: string | null | undefined): string {
  if (!pd || !/was|compare|rrp|msrp|list/i.test(pd)) return "";
  const m = pd.replace(/[^\d.]/g, "").match(/[\d.]+/);
  if (m && parseFloat(m[0]) > 0) return m[0];
  return "";
}

function weightFromAttrs(att: VisionAttrs | null | undefined): { weight: string; weight_unit: string } {
  if (!att) return { weight: "", weight_unit: "kg" };
  const wg = att.weight_grams;
  if (typeof wg === "number" && wg > 0) {
    const kg = Math.round((wg / 1000) * 1000) / 1000;
    return { weight: String(kg), weight_unit: "kg" };
  }
  const w = att.weight;
  if (typeof w === "string" && w.trim()) {
    const low = w.toLowerCase();
    const numMatch = w.match(/[\d.]+/);
    const num = numMatch ? parseFloat(numMatch[0]) : NaN;
    if (!Number.isFinite(num) || num <= 0) return { weight: "", weight_unit: "kg" };
    if (/\b(lb|lbs|pound)\b/.test(low)) return { weight: String(num), weight_unit: "lb" };
    if (/\boz\b/.test(low)) return { weight: String(num), weight_unit: "oz" };
    if (/\b(g|gram|grams)\b/.test(low) && num > 10) {
      const kg = Math.round((num / 1000) * 1000) / 1000;
      return { weight: String(kg), weight_unit: "kg" };
    }
    if (/\bkg\b|kilo/.test(low)) return { weight: String(num), weight_unit: "kg" };
    return { weight: String(num), weight_unit: "kg" };
  }
  return { weight: "", weight_unit: "kg" };
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

function guessSku(seoTitle: string, brand: string, exactModel: string): string {
  const raw = [brand, exactModel, seoTitle].filter(Boolean).join(" ");
  const slug = raw
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase();
  return slug.length > 48 ? slug.slice(0, 48) : slug;
}

function isEmptyVal(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string" && !v.trim()) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) return true;
  return false;
}

/**
 * Map vision extract → listing_extra.shopify (same keys as extension-review collectShopifyExtra).
 */
export function buildShopifyListingExtraFromVision(visionJson: VisionPayload): Record<string, unknown> {
  const copy = visionJson.extraction_copy || {};
  const att = visionJson.attributes || {};
  const tags = visionJson.tags || {};

  const seoTitle = (copy.seo_title && String(copy.seo_title).trim()) || "";
  const desc = (copy.description && String(copy.description).trim()) || "";
  const brandRaw = (att.brand && String(att.brand).trim()) || "";
  const useBrand = shouldUseExtractedBrandForMarketplaces(visionJson);
  const brand = useBrand ? brandRaw : "";
  const categoryFromTags = (tags.category && String(tags.category).trim()) || "";
  const categoryFromAttrs = att.category ? String(att.category).trim() : "";
  const kw = Array.isArray(tags.search_keywords)
    ? tags.search_keywords.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const categoryFromKeywords = kw.length ? kw.slice(0, 5).join(", ") : "";
  const productTypeFromAttr = (att.product_type && String(att.product_type).trim()) || "";
  const categoryRaw =
    categoryFromTags ||
    categoryFromAttrs ||
    productTypeFromAttr ||
    categoryFromKeywords;
  const productType =
    productTypeFromAttr || (categoryFromTags ? categoryFromTags.split(/[>›]/).pop()?.trim() || "" : "");
  const metaDesc = clipMeta(desc || seoTitle);
  const { weight, weight_unit } = weightFromAttrs(att);
  const compare_at = compareAtFromPriceDisplay(att.price_display || null);
  const barcode = guessBarcodeFromOcr(visionJson.raw_ocr_snippets);
  const exactModel = (att.exact_model && String(att.exact_model).trim()) || "";
  const sku = guessSku(seoTitle, brand, exactModel);

  const sizes =
    Array.isArray(att.detected_sizes) && att.detected_sizes.length
      ? att.detected_sizes.map((s) => String(s).trim()).filter(Boolean)
      : [];
  const colors =
    Array.isArray(att.detected_colors) && att.detected_colors.length
      ? att.detected_colors.map((c) => String(c).trim()).filter(Boolean)
      : [];
  const colorFallback =
    !colors.length && att.color && String(att.color).trim()
      ? String(att.color)
          .split(/[,;/]/)
          .map((c) => c.trim())
          .filter(Boolean)
      : [];

  const out: Record<string, unknown> = {
    vendor: brand || undefined,
    product_type: productType || undefined,
    category: categoryRaw || undefined,
    category_suggested: categoryRaw || undefined,
    tags: kw.length ? kw.join(", ") : undefined,
    seo_page_title: seoTitle || undefined,
    seo_meta_description: metaDesc || undefined,
    compare_at: compare_at || undefined,
    charge_tax: true,
    quantity: "1",
    unit_price: "",
  };

  if (weight) out.weight = weight;
  if (weight_unit) out.weight_unit = weight_unit;
  if (sku) out.sku = sku;
  if (barcode) out.barcode = barcode;
  if (sizes.length) out.sizes = sizes;
  if (colors.length) out.colors = colors;
  else if (colorFallback.length) out.colors = colorFallback;

  const cpf = visionJson.confidence_per_field;
  if (cpf != null && typeof cpf === "object" && !Array.isArray(cpf)) {
    const cleaned = Object.fromEntries(
      Object.entries(cpf as Record<string, unknown>).filter(([, v]) => v != null && v !== "")
    );
    if (Object.keys(cleaned).length) out.confidence_per_field = cleaned;
  }

  return Object.fromEntries(Object.entries(out).filter(([, v]) => !isEmptyVal(v)));
}

type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Deep-merge incoming shopify fields into prev listing_extra: only set keys that are empty in prev.shopify.
 */
/** Fields that represent product content — always overwrite with new extraction data. */
const SHOPIFY_ALWAYS_OVERWRITE = new Set(["body_html", "title", "product_type", "tags", "category", "category_suggested"]);

export function mergeShopifyIntoListingExtra(
  prevListingExtra: unknown,
  incomingShopify: Record<string, unknown>
): JsonObject {
  const root: JsonObject = isPlainObject(prevListingExtra) ? { ...(prevListingExtra as JsonObject) } : {};
  const prevShopRaw = root.shopify;
  const prevShop: JsonObject = isPlainObject(prevShopRaw) ? { ...(prevShopRaw as JsonObject) } : {};

  for (const [k, v] of Object.entries(incomingShopify)) {
    if (isEmptyVal(v)) continue;
    const cur = prevShop[k];
    // Always overwrite content fields so new scan descriptions replace previous product descriptions.
    if (!SHOPIFY_ALWAYS_OVERWRITE.has(k) && !isEmptyVal(cur)) continue;
    prevShop[k] = v;
  }

  root.shopify = prevShop;
  return root;
}
