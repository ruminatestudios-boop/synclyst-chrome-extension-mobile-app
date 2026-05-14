/**
 * Maps vision extract → listing_extra.vinted for Magic Fill on Vinted “Sell an item”.
 * Field names align with Vinted’s form: category, brand, size, measurements, condition, colours, material.
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

/** First two positive numbers in a dimensions string → shoulder / length style fields (UI uses inches). */
function firstTwoMeasurements(dim: string | null | undefined): { shoulder_width_in?: string; length_in?: string } {
  if (!dim || !String(dim).trim()) return {};
  const nums = String(dim).match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return {};
  return { shoulder_width_in: nums[0], length_in: nums[1] };
}

function materialLine(att: NonNullable<VisionPayload["attributes"]>): string {
  const comp = att.material_composition && String(att.material_composition).trim();
  if (comp) return comp;
  const m = att.material && String(att.material).trim();
  if (m) return m;
  const dm = Array.isArray(att.detected_materials)
    ? att.detected_materials.map((x) => String(x).trim()).filter(Boolean)
    : [];
  return dm.length ? dm.slice(0, 4).join(", ") : "";
}

/**
 * Vision → listing_extra.vinted (same extraction pipeline as Shopify; Vinted-only keys here).
 */
export function buildVintedListingExtraFromVision(visionJson: VisionPayload): Record<string, unknown> {
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
  const category =
    categoryFromTags || categoryFromAttrs || productType || categoryFromKeywords;

  const brandRaw = (att.brand && String(att.brand).trim()) || "";
  const brand = shouldUseExtractedBrandForMarketplaces(visionJson) ? brandRaw : "";
  const sizes = Array.isArray(att.detected_sizes)
    ? att.detected_sizes.map((s) => String(s).trim()).filter(Boolean)
    : [];
  /** Only persist size when vision saw label/packaging sizes (`detected_sizes`); otherwise omit — extension defaults to “One size”. */
  const size = sizes.length ? sizes[0] : "";

  const colorList =
    Array.isArray(att.detected_colors) && att.detected_colors.length
      ? att.detected_colors.map((c) => String(c).trim()).filter(Boolean).slice(0, 2)
      : att.color
        ? String(att.color)
            .split(/[,;/]/)
            .map((c) => c.trim())
            .filter(Boolean)
            .slice(0, 2)
        : [];

  const material = materialLine(att);
  const condition = att.condition ? String(att.condition).trim().replace(/_/g, " ") : "";
  const meas = firstTwoMeasurements(att.dimensions ? String(att.dimensions) : "");

  const out: Record<string, unknown> = {
    category: category || undefined,
    brand: brand || undefined,
    ...(size ? { size } : {}),
    condition: condition || undefined,
    material: material || undefined,
    colours: colorList.length ? colorList : undefined,
    shoulder_width_in: meas.shoulder_width_in,
    length_in: meas.length_in,
  };

  return Object.fromEntries(Object.entries(out).filter(([, v]) => !isEmptyVal(v)));
}

export function mergeVintedIntoListingExtra(
  prevListingExtra: unknown,
  incomingVinted: Record<string, unknown>
): JsonObject {
  const root: JsonObject = isPlainObject(prevListingExtra) ? { ...(prevListingExtra as JsonObject) } : {};
  const prevRaw = root.vinted;
  const prevV: JsonObject = isPlainObject(prevRaw) ? { ...(prevRaw as JsonObject) } : {};

  for (const [k, v] of Object.entries(incomingVinted)) {
    if (isEmptyVal(v)) continue;
    const cur = prevV[k];
    if (!isEmptyVal(cur)) continue;
    prevV[k] = v;
  }

  root.vinted = prevV;
  return root;
}
