/**
 * Vision / pairing → listing_extra.shopee (Seller Centre).
 *
 * Principles:
 * - Universal / vision “category” strings are hints only — they are NOT Shopee category IDs.
 * - Real marketplace data lives in category_id + optional category_path once known.
 * - Sources: universal_hint (this builder), later suggestion_api, barcode_lookup, user_ui — merged without giant crosswalks.
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

export type ShopeeCategorySource =
  | "universal_hint"
  | "suggestion_api"
  | "barcode_lookup"
  | "user_ui";

/**
 * Shopee-specific listing metadata. category_id is the Seller Centre / Open API leaf id when known.
 */
export type SnapPairShopeeExtra = {
  /** Optional manual product name for Seller Centre when vision title is wrong. */
  display_title?: string | null;
  category_id?: number | string | null;
  category_path?: string[] | null;
  /** Vision/universal text — search hint only. */
  category_hint?: string | null;
  /** Preferred string for the category picker search box. */
  category_search?: string | null;
  category_source?: ShopeeCategorySource | null;
  /** When true, Magic Fill should not auto-confirm a leaf; user confirms in UI. */
  category_needs_confirmation?: boolean | null;
  category_confidence?: number | null;
  /** Enables future barcode → catalog category resolution (no mapping table in-repo). */
  barcode?: string | null;
};

function universalCategoryHint(visionJson: VisionPayload): string {
  const tags = visionJson.tags || {};
  const att = visionJson.attributes || {};
  const categoryFromTags = (tags.category && String(tags.category).trim()) || "";
  const categoryFromAttrs = att.category ? String(att.category).trim() : "";
  const kw = Array.isArray(tags.search_keywords)
    ? tags.search_keywords.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const categoryFromKeywords = kw.length ? kw.slice(0, 5).join(", ") : "";
  const productType = (att.product_type && String(att.product_type).trim()) || "";
  return (
    categoryFromTags ||
    categoryFromAttrs ||
    productType ||
    categoryFromKeywords ||
    ""
  );
}

/**
 * Snapshot from vision: hints + optional barcode only. Does not call Shopee APIs (credentials + product context live elsewhere).
 */
export function buildShopeeListingExtraFromVision(visionJson: VisionPayload): Record<string, unknown> {
  const att = (visionJson.attributes || {}) as Record<string, unknown>;
  const ocrRaw = att.ocr_snippets ?? att.ocrSnippets ?? visionJson.raw_ocr_snippets;
  const gtin = typeof att.gtin === "string" ? att.gtin.replace(/\D/g, "") : "";
  const upc = typeof att.upc === "string" ? att.upc.replace(/\D/g, "") : "";
  const barcode = gtin || upc || guessBarcodeFromOcr(ocrRaw);

  const hint = universalCategoryHint(visionJson).replace(/\s+/g, " ").trim();
  const search = hint ? hint.slice(0, 200) : "";

  const rawAtt = visionJson.attributes;
  const brandRaw =
    rawAtt && typeof rawAtt.brand === "string" && rawAtt.brand.trim() ? rawAtt.brand.trim() : "";
  const brand = shouldUseExtractedBrandForMarketplaces(visionJson) ? brandRaw : "";
  const material =
    rawAtt && typeof rawAtt.material === "string" && rawAtt.material.trim() ? rawAtt.material.trim() : "";

  const out: Record<string, unknown> = {
    category_hint: hint || undefined,
    category_search: search || undefined,
    category_source: hint || barcode ? "universal_hint" : undefined,
    category_needs_confirmation: hint ? false : undefined,
    barcode: barcode && barcode.length >= 8 ? barcode : undefined,
    brand: brand || undefined,
    material: material || undefined,
  };

  return Object.fromEntries(Object.entries(out).filter(([, v]) => !isEmptyVal(v)));
}

function isAuthoritativeCategorySource(s: unknown): boolean {
  return s === "user_ui" || s === "suggestion_api" || s === "barcode_lookup";
}

/**
 * Merge vision snapshot into existing shopee block without clobbering user- or API-resolved categories.
 */
export function mergeShopeeIntoListingExtra(
  prevListingExtra: unknown,
  incomingShopee: Record<string, unknown>
): JsonObject {
  const root: JsonObject = isPlainObject(prevListingExtra) ? { ...(prevListingExtra as JsonObject) } : {};
  const prevRaw = root.shopee;
  const prevS: JsonObject = isPlainObject(prevRaw) ? { ...(prevRaw as JsonObject) } : {};

  const lockedCategoryId = !isEmptyVal(prevS.category_id);

  for (const [k, v] of Object.entries(incomingShopee)) {
    if (isEmptyVal(v)) continue;

    if (k === "category_id" || k === "category_path") {
      if (lockedCategoryId) continue;
      if (!isEmptyVal(prevS[k])) continue;
      prevS[k] = v;
      continue;
    }

    if (k === "category_hint" || k === "category_search") {
      if (!isEmptyVal(prevS[k])) continue;
      prevS[k] = v;
      continue;
    }

    if (k === "category_source" || k === "category_needs_confirmation" || k === "category_confidence") {
      if (isAuthoritativeCategorySource(prevS.category_source)) continue;
      if (!isEmptyVal(prevS[k])) continue;
      prevS[k] = v;
      continue;
    }

    const cur = prevS[k];
    if (!isEmptyVal(cur)) continue;
    prevS[k] = v;
  }

  root.shopee = prevS;
  return root;
}
