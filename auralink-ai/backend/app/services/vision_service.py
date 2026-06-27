"""
Vision extraction: MultimodalProcessor with Gemini 2.0 Flash or GPT-4o.
UCP + schema.org/Product aligned; Fact-Feel-Proof (GEO) copy.
"""
import asyncio
import json
import re
import base64
import logging
from typing import Optional

from pydantic import ValidationError
from app.schemas.vision import (
    VisionExtractionResponse,
    ExtractionAttributes,
    ExtractionCopy,
    ExtractionTags,
    FactFeelProof,
    InvoiceExtractionResponse,
    InvoiceLineItem,
)
from app.config import get_settings

logger = logging.getLogger(__name__)

class VisionServiceError(Exception):
    """Raised when vision provider calls fail in a user-actionable way."""


def _genai_client(api_key: str):
    try:
        import google.genai as genai
    except ImportError as e:
        raise VisionServiceError(
            "Gemini SDK missing for the Python process running uvicorn. "
            "From auralink-ai/backend: source .venv/bin/activate && pip install -r requirements.txt, then restart the API."
        ) from e
    return genai.Client(api_key=api_key)


def _genai_types():
    try:
        from google.genai import types
    except ImportError as e:
        raise VisionServiceError(
            "Gemini SDK missing for the Python process running uvicorn. "
            "From auralink-ai/backend: source .venv/bin/activate && pip install -r requirements.txt, then restart the API."
        ) from e
    return types


def _extract_response_text(response) -> str:
    text = getattr(response, "text", None)
    if text:
        return str(text).strip()
    try:
        candidates = getattr(response, "candidates", None) or []
        parts = (getattr(candidates[0], "content", None).parts or []) if candidates else []
        out = []
        for p in parts:
            t = getattr(p, "text", None)
            if t:
                out.append(str(t))
        return "\n".join(out).strip()
    except Exception:
        return ""


try:
    from app.prompts import VLM_SYSTEM_PROMPT, build_user_prompt
except ImportError:
    VLM_SYSTEM_PROMPT = None
    build_user_prompt = None

# Product type → estimated weight (kg) when not visible in image. Never send 0 to Shopify.
WEIGHT_ESTIMATES_KG = {
    "dog collar": 0.15,
    "dog lead": 0.20,
    "cat collar": 0.05,
    "t-shirt": 0.20,
    "tshirt": 0.20,
    "tee": 0.20,
    "hoodie": 0.60,
    "sweatshirt": 0.60,
    "sweater": 0.50,
    "jumper": 0.50,
    "jeans": 0.70,
    "trousers": 0.60,
    "pants": 0.60,
    "shorts": 0.40,
    "jacket": 0.90,
    "coat": 1.00,
    "dress": 0.35,
    "top": 0.25,
    "blouse": 0.25,
    "shoes": 0.80,
    "trainers": 0.90,
    "sneakers": 0.90,
    "boots": 1.00,
    "headphones": 0.30,
    "earphones": 0.05,
    "earbuds": 0.05,
    "phone": 0.20,
    "smartphone": 0.20,
    "laptop": 1.80,
    "tablet": 0.50,
    "smartwatch": 0.05,
    "watch": 0.15,
    "camera": 0.40,
    "mug": 0.35,
    "book": 0.30,
    "candle": 0.25,
    "picture frame": 0.40,
    "handbag": 0.50,
    "bag": 0.45,
    "wallet": 0.10,
    "sunglasses": 0.03,
    "jewellery": 0.05,
    "jewelry": 0.05,
    "necklace": 0.05,
    "bracelet": 0.03,
    "ring": 0.01,
    "backpack": 0.60,
    "umbrella": 0.40,
    "belt": 0.25,
    "scarf": 0.15,
    "hat": 0.15,
    "gloves": 0.10,
    "socks": 0.05,
    "underwear": 0.05,
    "sports": 0.50,
    "equipment": 0.80,
    "skincare": 0.20,
    "cosmetics": 0.15,
    "bottle": 0.40,
    "box": 0.30,
}


def _weight_estimate_kg(product_type_or_category: Optional[str]) -> Optional[float]:
    """Return estimated weight in kg for product type, or None for default 0.5."""
    if not product_type_or_category or not isinstance(product_type_or_category, str):
        return None
    key = product_type_or_category.lower().strip()
    for k, v in WEIGHT_ESTIMATES_KG.items():
        if k in key or key in k:
            return v
    return None


def apply_post_extraction(result: VisionExtractionResponse) -> VisionExtractionResponse:
    """Apply weight estimate when missing; ensure we never leave weight at 0."""
    att = result.attributes
    product_type = att.product_type or result.tags.category or ""
    has_weight = att.weight_grams is not None and att.weight_grams > 0
    if not has_weight and product_type:
        est = _weight_estimate_kg(product_type)
        if est is not None:
            att.weight_grams = est * 1000  # store in grams
            att.weight_source = "estimated"
    if not has_weight and (att.weight_grams is None or att.weight_grams <= 0):
        att.weight_grams = 500  # default 0.5 kg in grams
        att.weight_source = "estimated"
    return result


# Blocklist: treat as null so OCR or web can fill (no generic output for paid use)
GENERIC_BRAND_BLOCKLIST = frozenset({
    "product", "generic", "unknown", "unknown brand", "various", "n/a", "none", "unbranded", "other", ""
})
GENERIC_TITLE_BLOCKLIST = frozenset({
    "product", "generic product", "unknown product", "item", "product name", "nothing", ""
})


def _in_blocklist(s: Optional[str], blocklist: frozenset) -> bool:
    if not s or not s.strip():
        return True
    return s.strip().lower() in blocklist


def _ocr_text_contains(ocr_snippets: list[str], value: Optional[str]) -> bool:
    """True if value appears in OCR text (substring, case-insensitive)."""
    if not value or not value.strip() or not ocr_snippets:
        return False
    combined = " ".join(ocr_snippets).lower()
    return value.strip().lower() in combined


def _apply_weak_title_composite_fallback(result: VisionExtractionResponse) -> VisionExtractionResponse:
    """If seo_title is weak (material line, brand-only, etc.), build brand + type + keywords — never brand alone."""
    from app.services.product_title_heuristics import is_weak_listing_title

    copy = result.extraction_copy
    att = result.attributes
    tags = result.tags
    if not is_weak_listing_title(copy.seo_title, att.brand):
        return result
    parts: list[str] = []
    if att.brand and str(att.brand).strip():
        parts.append(str(att.brand).strip())
    pt = (att.product_type or tags.category or "").strip()
    if pt:
        brand_low = (att.brand or "").lower()
        pl = pt.lower()
        if pl not in brand_low and brand_low not in pl:
            parts.append(pt)
    brand_key = (att.brand or "").lower()
    if len(parts) < 2:
        for k in tags.search_keywords or []:
            ks = str(k).strip()
            # A real keyword is a short tag ("streetwear", "graphic tee"), not a sentence. The
            # model occasionally puts a description-like phrase in search_keywords; joining two
            # of those here produced a run-on, mid-sentence-truncated title.
            if not ks or len(ks) < 2 or len(ks) > 30 or ks.count(" ") > 4:
                continue
            kl = ks.lower()
            if brand_key and (kl == brand_key or kl in brand_key or brand_key in kl):
                continue
            if any(kl == p.lower() for p in parts):
                continue
            parts.append(ks)
            if len(parts) >= 2:
                break
    composite = " ".join(parts).strip()[:200]
    cur = (copy.seo_title or "").strip()
    if len(composite.split()) < 2:
        return result
    if composite.lower() == (att.brand or "").strip().lower():
        return result
    if composite and len(composite) > len(cur):
        copy.seo_title = composite
        sources = dict(result.sources or {})
        prev = sources.get("seo_title")
        if prev not in ("web", "web_page"):
            sources["seo_title"] = "derived"
        result.sources = sources
    return result


def apply_blocklist_and_ocr_validation(
    result: VisionExtractionResponse,
    ocr_snippets: list[str],
) -> VisionExtractionResponse:
    """Apply blocklist (null generic brand/title) and OCR-first overwrite when VLM disagrees or is generic."""
    from app.services.ocr_service import best_brand_and_title_from_ocr

    att = result.attributes
    copy = result.extraction_copy
    sources = dict(result.sources or {})

    # Blocklist: clear generic brand/title
    if _in_blocklist(att.brand, GENERIC_BRAND_BLOCKLIST):
        att.brand = None
    if _in_blocklist(copy.seo_title, GENERIC_TITLE_BLOCKLIST):
        copy.seo_title = "Product"

    brand_cand, title_cand = best_brand_and_title_from_ocr(ocr_snippets)

    # OCR overwrite: prefer OCR when we have a candidate and (current is missing/generic or not in OCR)
    if brand_cand and (not att.brand or _in_blocklist(att.brand, GENERIC_BRAND_BLOCKLIST) or not _ocr_text_contains(ocr_snippets, att.brand)):
        att.brand = brand_cand
        sources["brand"] = "ocr"
    if title_cand and (copy.seo_title == "Product" or _in_blocklist(copy.seo_title, GENERIC_TITLE_BLOCKLIST) or not _ocr_text_contains(ocr_snippets, copy.seo_title)):
        copy.seo_title = title_cand
        sources["seo_title"] = "ocr"

    result.sources = sources if sources else None
    result = _apply_weak_title_composite_fallback(result)
    return result


def apply_normalizer(result: VisionExtractionResponse) -> VisionExtractionResponse:
    """Normalize title and brand once (trim, optional title case for brand)."""
    att = result.attributes
    copy = result.extraction_copy
    if att.brand and isinstance(att.brand, str):
        att.brand = att.brand.strip()
        if len(att.brand) > 1 and att.brand.isupper():
            att.brand = att.brand.title()
    if copy.seo_title and isinstance(copy.seo_title, str):
        # 200 was loose enough to let description-like text bleed into the title and get cut
        # off mid-sentence (e.g. "...this Supreme t-shirt features a prominent graphic print of
        # rap"). A real product title fits comfortably in ~100 chars.
        copy.seo_title = copy.seo_title.strip()[:100]
    return result


def _run_verification_pass_sync(
    result: VisionExtractionResponse,
    ocr_snippets: list[str],
    gemini_api_key: Optional[str],
) -> Optional[dict]:
    """Text-only consistency check: given OCR and draft, return corrections for brand, seo_title, exact_model. Returns None on failure."""
    if not ocr_snippets or not gemini_api_key or not gemini_api_key.strip():
        return None
    ocr_block = "\n".join(ocr_snippets[:30])
    draft = {
        "brand": result.attributes.brand,
        "seo_title": result.extraction_copy.seo_title,
        "exact_model": result.attributes.exact_model,
        "make": result.attributes.make,
        "model_year": result.attributes.model_year,
    }
    prompt = f"""Given the OCR text from a product label and the current draft fields, output ONLY a JSON object with the corrected values. Use the EXACT text from the OCR when the draft is wrong or missing. If a field is correct or not in OCR, use null for that key.

OCR text:
{ocr_block}

Current draft:
{json.dumps(draft)}

Output ONLY valid JSON (no markdown), e.g. {{ "brand": "exact from OCR or null", "seo_title": "exact from OCR or null", "exact_model": "exact from OCR or null", "make": "exact from OCR or null", "model_year": "2024 or SS24 or null" }}. Only include keys that need correction; use null to mean "no change". For model_year use the exact year or season code from the label (e.g. 2024, SS24, FW23)."""

    try:
        from google.genai import types
        client = _genai_client(gemini_api_key)
        for model_name in _candidate_gemini_models(client):
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        temperature=0,
                        max_output_tokens=512,
                    ),
                )
                text = _extract_response_text(response)
                text = re.sub(r"^```(?:json)?\s*", "", text)
                text = re.sub(r"\s*```\s*$", "", text)
                data = json.loads(text)
                if isinstance(data, dict) and (data.get("brand") is not None or data.get("seo_title") is not None or data.get("exact_model") is not None or data.get("make") is not None or data.get("model_year") is not None):
                    return data
            except Exception as e2:
                err2 = str(e2).lower()
                if "not found" in err2 or "404" in err2:
                    continue
                raise
    except Exception as e:
        logger.debug("Verification pass failed: %s", e)
    return None


def _candidate_gemini_models(client=None) -> list[str]:
    """
    Return a preferred list of Gemini model names for generate_content.
    Uses list_models() when available to avoid 404s for keys without access.
    """
    # Omit gemini-2.0-flash-lite: Google returns 404 for new API users ("no longer available").
    preferred = [
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
        "gemini-2.5-flash-lite",
    ]
    # Never use these in fallback even if list_models() still names them.
    _blocked = frozenset({"gemini-2.0-flash-lite"})
    try:
        c = client
        if c is None:
            settings = get_settings()
            if not settings.gemini_api_key:
                return [m for m in preferred if m not in _blocked]
            c = _genai_client(settings.gemini_api_key)
        available = []
        for m in c.models.list():
            name = getattr(m, "name", "") or ""
            short = name.split("/")[-1] if "/" in name else name
            if short and short.startswith("gemini-"):
                available.append(short)
        # Keep preferred ordering but only include models the key can actually use
        picked = [m for m in preferred if m in available and m not in _blocked]
        out = picked or [m for m in preferred if m not in _blocked]
        return out
    except Exception:
        return [m for m in preferred if m not in _blocked]


def apply_verification_pass(
    result: VisionExtractionResponse,
    ocr_snippets: list[str],
    gemini_api_key: Optional[str],
) -> VisionExtractionResponse:
    """Optional OCR–draft consistency pass: overwrite brand/title/model when verification suggests correction."""
    corrections = _run_verification_pass_sync(result, ocr_snippets, gemini_api_key)
    if not corrections:
        return result
    sources = dict(result.sources or {})
    if corrections.get("brand") is not None and str(corrections["brand"]).strip():
        result.attributes.brand = str(corrections["brand"]).strip()[:100]
        sources["brand"] = "ocr"
    if corrections.get("seo_title") is not None and str(corrections["seo_title"]).strip():
        result.extraction_copy.seo_title = str(corrections["seo_title"]).strip()[:200]
        sources["seo_title"] = "ocr"
    if corrections.get("exact_model") is not None and str(corrections["exact_model"]).strip():
        result.attributes.exact_model = str(corrections["exact_model"]).strip()[:100]
        sources["exact_model"] = "ocr"
    if corrections.get("make") is not None and str(corrections["make"]).strip():
        result.attributes.make = str(corrections["make"]).strip()[:100]
        sources["make"] = "ocr"
    if corrections.get("model_year") is not None and str(corrections["model_year"]).strip():
        result.attributes.model_year = str(corrections["model_year"]).strip()[:20]
        sources["model_year"] = "ocr"
    result.sources = sources
    result = _apply_weak_title_composite_fallback(result)
    return result


def _decode_base64(image_base64: str) -> tuple[bytes, str]:
    """Return (raw_bytes, mime_type). Handles data URL prefix."""
    data = image_base64.strip()
    mime = "image/jpeg"
    if data.startswith("data:"):
        # data:image/jpeg;base64,<payload>
        match = re.match(r"data:([^;]+);base64,", data)
        if match:
            mime = match.group(1).strip()
        data = data.split(",", 1)[-1]
    raw = base64.b64decode(data, validate=True)
    return raw, mime


def _float_or_none(val) -> Optional[float]:
    """Return float or None for price_value, weight_grams, etc."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _fallback_extraction() -> VisionExtractionResponse:
    """Return a safe extraction when parsing or validation fails."""
    return VisionExtractionResponse(
        attributes=ExtractionAttributes(),
        extraction_copy=ExtractionCopy(seo_title="Product", description="", bullet_points=[]),
        tags=ExtractionTags(),
        confidence_score=0.5,
    )


def get_fallback_extraction() -> VisionExtractionResponse:
    """Public fallback for route when extraction validation fails."""
    return _fallback_extraction()


def _list_str(val):
    """Return list of strings or None."""
    if val is None:
        return None
    if isinstance(val, list):
        return [str(x).strip() for x in val if x is not None and str(x).strip()]
    return None


def _coerce_parsed_extraction_dict(data: dict) -> dict:
    """Mutate/return a copy-safe dict so Pydantic (0–1 fields, list lengths, title max) does not reject model output."""
    if not isinstance(data, dict):
        return {}

    def _d(val):
        return val if isinstance(val, dict) else {}

    out = data
    # Top-level confidence
    c = out.get("confidence_score", 1.0)
    try:
        c = float(c)
    except (TypeError, ValueError):
        c = 0.5
    out["confidence_score"] = max(0.0, min(1.0, c))

    att = _d(out.get("attributes"))
    for key in ("price_confidence", "condition_score"):
        if att.get(key) is None:
            continue
        f = _float_or_none(att.get(key))
        att[key] = max(0.0, min(1.0, f)) if f is not None else None
    out["attributes"] = att

    copy_d = _d(out.get("copy"))
    st = copy_d.get("seo_title")
    if st is not None and st != "":
        copy_d["seo_title"] = str(st)[:200]
    bps = copy_d.get("bullet_points")
    if isinstance(bps, list):
        copy_d["bullet_points"] = [str(b) for b in bps[:10]]
    out["copy"] = copy_d

    tags = _d(out.get("tags"))
    sk = tags.get("search_keywords")
    if isinstance(sk, list):
        tags["search_keywords"] = [str(x) for x in sk[:30]]
    out["tags"] = tags
    return out


def _extract_balanced_json_objects(s: str) -> list:
    """Return substrings for each top-level `{ ... }` pair (handles nesting)."""
    res = []
    depth = 0
    start = -1
    for i, ch in enumerate(s):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start != -1:
                res.append(s[start : i + 1])
                start = -1
    return res


def _json_string_candidates(text: str) -> list:
    """
    All strings worth trying with json.loads (longest / most likely object first).
    Fixes 'invalid JSON' when the model adds prose, multiple objects, or broken trailing commas.
    """
    raw = text.strip() if text else ""
    if not raw:
        return []
    seen = set()
    out = []

    def push(s: str):
        t = s.strip() if s else ""
        if len(t) < 2 or t in seen:
            return
        seen.add(t)
        out.append(t)

    push(raw)
    for m in re.finditer(r"```(?:json)?\s*([\s\S]*?)\s*```", raw):
        push(m.group(1).strip())
    for obj in sorted(_extract_balanced_json_objects(raw), key=len, reverse=True):
        push(obj)
    start, end = raw.find("{"), raw.rfind("}")
    if start != -1 and end != -1 and end > start:
        push(raw[start : end + 1])
    return out


def _strip_trailing_commas(s: str) -> str:
    """Remove a comma that immediately precedes a closing `}` or `]` (ignoring whitespace).
    Vision models frequently emit `{"a": 1,}` / `[1, 2,]` — stdlib `json` rejects these outright."""
    return re.sub(r",(\s*[}\]])", r"\1", s)


def _json_loads_salvage(text: str) -> dict:
    last_err = None
    for candidate in _json_string_candidates(text):
        # Try the candidate as-is first, then with trailing commas stripped — most model
        # output parses fine outright, so only pay the extra regex pass when needed.
        for attempt in (candidate, _strip_trailing_commas(candidate)):
            try:
                data = json.loads(attempt)
                if isinstance(data, dict):
                    return data
            except json.JSONDecodeError as e:
                last_err = e
                continue
    # `logger.debug` is filtered out by Cloud Run's default log level, so every failure here
    # was invisible in production — bump to `warning` and include a snippet of the raw model
    # output so the next failure is actually diagnosable instead of a guess.
    snippet = (text or "")[:800]
    logger.warning("JSON salvage failed (%s). Raw model output (first 800 chars): %r", last_err, snippet)
    raise VisionServiceError("Vision model returned invalid JSON")


def _str_schema(genai_types, nullable: bool = True):
    s = genai_types.Schema(type="STRING")
    if nullable:
        s.nullable = True
    return s


def _num_schema(genai_types, nullable: bool = True):
    s = genai_types.Schema(type="NUMBER")
    if nullable:
        s.nullable = True
    return s


def _build_ucp_gemini_response_schema(genai_types):
    """
    Enforce JSON object shape in API (Gemini response_schema + response_mime_type=application/json).
    Eliminates most markdown / prose / malformed JSON from free-form text generation.
    """
    g = genai_types
    ffp = g.Schema(
        type="OBJECT",
        properties={
            "fact": _str_schema(g, True),
            "feel": _str_schema(g, True),
            "proof": _str_schema(g, True),
        },
    )
    copy_obj = g.Schema(
        type="OBJECT",
        properties={
            "seo_title": g.Schema(type="STRING"),
            "description": _str_schema(g, True),
            "description_fact_feel_proof": ffp,
            "bullet_points": g.Schema(
                type="ARRAY",
                items=g.Schema(type="STRING"),
            ),
        },
    )
    attrs = g.Schema(
        type="OBJECT",
        properties={
            "material": _str_schema(g, True),
            "color": _str_schema(g, True),
            "weight": _str_schema(g, True),
            "dimensions": _str_schema(g, True),
            "brand": _str_schema(g, True),
            "make": _str_schema(g, True),
            "exact_model": _str_schema(g, True),
            "model_year": _str_schema(g, True),
            "material_composition": _str_schema(g, True),
            "weight_grams": _num_schema(g, True),
            "weight_source": _str_schema(g, True),
            "condition_score": _num_schema(g, True),
            "condition": _str_schema(g, True),
            "price_display": _str_schema(g, True),
            "price_value": _num_schema(g, True),
            "price_source": _str_schema(g, True),
            "price_confidence": _num_schema(g, True),
            "detected_colors": g.Schema(
                type="ARRAY",
                items=g.Schema(type="STRING"),
            ),
            "detected_sizes": g.Schema(
                type="ARRAY",
                items=g.Schema(type="STRING"),
            ),
            "detected_materials": g.Schema(
                type="ARRAY",
                items=g.Schema(type="STRING"),
            ),
            "product_type": _str_schema(g, True),
        },
    )
    tags = g.Schema(
        type="OBJECT",
        properties={
            "category": _str_schema(g, True),
            "search_keywords": g.Schema(
                type="ARRAY",
                items=g.Schema(type="STRING"),
            ),
        },
    )
    return g.Schema(
        type="OBJECT",
        required=["attributes", "copy", "tags", "confidence_score"],
        properties={
            "ucp_version": _str_schema(g, True),
            "schema_context": _str_schema(g, True),
            "attributes": attrs,
            "copy": copy_obj,
            "tags": tags,
            "raw_ocr_snippets": g.Schema(
                type="ARRAY",
                items=g.Schema(type="STRING"),
            ),
            "confidence_score": g.Schema(type="NUMBER"),
            "confidence_per_field": g.Schema(type="OBJECT", nullable=True),
        },
    )


def _structured_schema_api_error(e: Exception) -> bool:
    """
    Some models/keys return INVALID_ARGUMENT for response_schema; retry without structured output.
    """
    err = (str(e) or "").lower()
    if not err:
        return False
    return any(
        x in err
        for x in (
            "response_schema",
            "json_schema",
            "response_mime_type",
            "response mime",
            "schemat",
            "invalid_argument",
            "not supported",
            "unsupported",
            "unknown name",
        )
    )


def _parse_extraction_response(text: str) -> VisionExtractionResponse:
    """Parse model output into VisionExtractionResponse (legacy or UCP format)."""
    def _dict(val):
        return val if isinstance(val, dict) else {}

    text = (text or "").strip()
    if not text:
        raise VisionServiceError("Vision model returned non-JSON output")
    data = _json_loads_salvage(text)
    if not isinstance(data, dict):
        data = {}
    data = _coerce_parsed_extraction_dict(data)
    # UCP format (new) has description_fact_feel_proof, weight_grams, etc.
    copy_data = _dict(data.get("copy"))
    if data.get("ucp_version") or copy_data.get("description_fact_feel_proof"):
        try:
            return _parse_ucp_extraction_response(data)
        except (ValidationError, TypeError, ValueError, KeyError) as e:
            logger.warning("UCP parse failed, trying legacy shape: %s", e)
            # Join Fact-Feel-Proof into description so the legacy path can still produce a useful listing.
            ffp = copy_data.get("description_fact_feel_proof")
            if isinstance(ffp, dict) and not (copy_data.get("description") or "").strip():
                parts = [ffp.get("fact"), ffp.get("feel"), ffp.get("proof")]
                copy_data = {**copy_data, "description": " ".join(str(p).strip() for p in parts if p).strip()}
            data = {**data, "copy": copy_data}
            data.pop("ucp_version", None)
    att = _dict(data.get("attributes"))
    copy_data = _dict(data.get("copy"))
    tags_data = _dict(data.get("tags"))
    price_src = att.get("price_source")
    price_conf = _float_or_none(att.get("price_confidence"))
    price_val = _float_or_none(att.get("price_value"))
    price_disp = att.get("price_display")
    if price_src == "not_found":
        price_val = None
        price_disp = None
    # Keep ai_suggested prices regardless of confidence — user can always adjust
    try:
        return VisionExtractionResponse(
            attributes=ExtractionAttributes(
                material=att.get("material"),
                color=att.get("color"),
                weight=att.get("weight"),
                dimensions=att.get("dimensions"),
                brand=att.get("brand"),
                make=att.get("make"),
                model_year=att.get("model_year"),
                price_display=price_disp,
                price_value=price_val,
                price_source=price_src if price_src in ("found_in_image", "ai_suggested", "not_found") else None,
                price_confidence=price_conf,
                detected_colors=_list_str(att.get("detected_colors")),
                detected_sizes=_list_str(att.get("detected_sizes")),
                detected_materials=_list_str(att.get("detected_materials")),
                product_type=att.get("product_type"),
            ),
            extraction_copy=ExtractionCopy(
                seo_title=copy_data.get("seo_title") or "Product",
                description=copy_data.get("description") or "",
                bullet_points=copy_data.get("bullet_points") if isinstance(copy_data.get("bullet_points"), list) else [],
            ),
            tags=ExtractionTags(
                category=tags_data.get("category"),
                search_keywords=tags_data.get("search_keywords") if isinstance(tags_data.get("search_keywords"), list) else [],
            ),
            raw_ocr_snippets=data.get("raw_ocr_snippets") if isinstance(data.get("raw_ocr_snippets"), list) else [],
            confidence_score=float(data.get("confidence_score", 1.0)),
        )
    except (ValidationError, TypeError, ValueError) as e:
        logger.warning("Legacy parse fallback: %s", e)
        raise VisionServiceError("Vision model returned invalid extraction fields")


def _parse_ucp_extraction_response(data: dict) -> VisionExtractionResponse:
    """Parse UCP/schema.org JSON into VisionExtractionResponse."""
    def _dict(val):
        return val if isinstance(val, dict) else {}

    att = _dict(data.get("attributes"))
    copy_data = _dict(data.get("copy"))
    ffp = copy_data.get("description_fact_feel_proof") or {}
    if isinstance(ffp, dict):
        fact_feel_proof = FactFeelProof(
            fact=ffp.get("fact"),
            feel=ffp.get("feel"),
            proof=ffp.get("proof"),
        )
    else:
        fact_feel_proof = None
    # Build legacy description from fact+feel+proof for backward compatibility
    desc_parts = []
    if fact_feel_proof and fact_feel_proof.fact:
        desc_parts.append(fact_feel_proof.fact)
    if fact_feel_proof and fact_feel_proof.feel:
        desc_parts.append(fact_feel_proof.feel)
    if fact_feel_proof and fact_feel_proof.proof:
        desc_parts.append(fact_feel_proof.proof)
    description = " ".join(desc_parts).strip() if desc_parts else copy_data.get("description") or ""

    weight_val = att.get("weight_grams")
    if weight_val is not None and not isinstance(weight_val, (int, float)):
        try:
            weight_val = float(weight_val)
        except (TypeError, ValueError):
            weight_val = None

    price_src = att.get("price_source")
    price_conf = _float_or_none(att.get("price_confidence"))
    price_val = _float_or_none(att.get("price_value"))
    price_disp = att.get("price_display")
    if price_src == "not_found":
        price_val = None
        price_disp = None
    # Keep ai_suggested prices regardless of confidence — user can always adjust

    condition_val = att.get("condition")
    if condition_val and str(condition_val).lower() not in ("new", "like_new", "good", "fair", "for_parts"):
        condition_val = None

    conf_per_field = data.get("confidence_per_field")
    if not isinstance(conf_per_field, dict):
        conf_per_field = None

    seo_title = str(copy_data.get("seo_title") or "Product").strip() or "Product"
    seo_title = seo_title[:200]

    return VisionExtractionResponse(
        attributes=ExtractionAttributes(
            material=att.get("material"),
            color=att.get("color"),
            weight=att.get("weight") or (f"{int(weight_val)}g" if isinstance(weight_val, (int, float)) and weight_val else None),
            dimensions=att.get("dimensions"),
            brand=att.get("brand"),
            make=att.get("make"),
            model_year=att.get("model_year"),
            price_display=price_disp,
            price_value=price_val,
            price_source=price_src if price_src in ("found_in_image", "ai_suggested", "not_found") else None,
            price_confidence=price_conf,
            exact_model=att.get("exact_model"),
            material_composition=att.get("material_composition"),
            weight_grams=weight_val,
            weight_source=att.get("weight_source"),
            condition_score=att.get("condition_score"),
            condition=condition_val,
            detected_colors=_list_str(att.get("detected_colors")),
            detected_sizes=_list_str(att.get("detected_sizes")),
            detected_materials=_list_str(att.get("detected_materials")),
            product_type=att.get("product_type"),
        ),
        extraction_copy=ExtractionCopy(
            seo_title=seo_title,
            description=description,
            bullet_points=copy_data.get("bullet_points") if isinstance(copy_data.get("bullet_points"), list) else [],
            description_fact_feel_proof=fact_feel_proof,
        ),
        tags=ExtractionTags(
            category=_dict(data.get("tags")).get("category"),
            search_keywords=sk if isinstance(sk := _dict(data.get("tags")).get("search_keywords"), list) else [],
        ),
        raw_ocr_snippets=data.get("raw_ocr_snippets") if isinstance(data.get("raw_ocr_snippets"), list) else [],
        confidence_score=float(data.get("confidence_score", 1.0)),
        confidence_per_field=conf_per_field,
        ucp_version=data.get("ucp_version"),
        schema_context=data.get("schema_context"),
    )


EXTRACTION_SYSTEM = """You are a strict product data extractor. Copy EXACT text from the product image and OCR. Never use generic placeholders like "Product", "Unknown brand", or "Various".

Rules:
- brand: EXACT brand from logo/label (e.g. Sony, LEGO, Nike). Copy spelling and capitalization. If not visible, use null.
- seo_title: EXACT product name as printed (e.g. "WH-1000XM5 Wireless Headphones", "Classic Fit Jeans"). Not a generic category.
- exact_model: Model number, SKU, or style code from label when visible. null otherwise.
- make: Manufacturer or parent brand when different from brand (e.g. vehicles, electronics). null if not visible.
- model_year: Year or season code from label (e.g. 2024, SS24, FW23). null otherwise.
- material_composition: Exact material text from label (e.g. "100% Cotton"). Not "fabric" or "material".
- When in doubt, use null. Do not guess or substitute generic terms.

Output ONLY valid JSON (no markdown):

{
  "attributes": {
    "material": "exact from label or null",
    "color": "primary color(s) if visible",
    "weight": "e.g. 200g if visible",
    "dimensions": "from label if visible",
    "brand": "exact brand or null",
    "make": "manufacturer or null",
    "model_year": "2024 or SS24 or null",
    "price_display": "as shown or null",
    "price_value": number or null — if price not visible, estimate a realistic UK resale/retail price based on brand, product type, condition and typical market value,
    "price_source": "found_in_image if price visible on product/tag, ai_suggested if you estimated it, not_found only if you truly cannot identify the product",
    "detected_colors": ["color names from image or description"],
    "detected_sizes": ["size if visible"] or [],
    "detected_materials": ["materials from label"],
    "product_type": "e.g. dog collar, t-shirt"
  },
  "copy": {
    "seo_title": "EXACT product name from package; never generic",
    "description": "Specs and details from the product",
    "bullet_points": ["Specific feature from product", "…"]
  },
  "tags": {
    "category": "Specific category",
    "search_keywords": ["brand", "model", "specific terms from product"]
  },
  "raw_ocr_snippets": ["exact snippets used"],
  "confidence_score": 0.0 to 1.0
}"""


def _get_system_prompt() -> str:
    """Use UCP VLM prompt when available, else legacy."""
    if VLM_SYSTEM_PROMPT:
        return VLM_SYSTEM_PROMPT
    return EXTRACTION_SYSTEM


def _get_user_prompt(ocr_snippets: list[str]) -> str:
    """Use build_user_prompt when available, else legacy."""
    if build_user_prompt:
        return build_user_prompt(ocr_snippets)
    ocr_block = "\n".join(ocr_snippets) if ocr_snippets else "No OCR text provided."
    return f"""Extract from this image. Use OCR below as primary source—copy exact strings for brand, product name, model, and price. Do not output "Product" or "Unknown brand"; use null if not readable.

OCR text:
{ocr_block}

Output ONLY the JSON object (attributes, copy, tags, raw_ocr_snippets, confidence_score)."""


def _gemini_extract_sync(
    image_base64: str,
    mime_type: str,
    ocr_snippets: list[str],
    fast_mode: bool = False,
) -> VisionExtractionResponse:
    """Synchronous Gemini call (MultimodalProcessor)."""
    types = _genai_types()
    ucp_schema = _build_ucp_gemini_response_schema(types)

    settings = get_settings()
    if not settings.gemini_api_key:
        raise VisionServiceError("Gemini API key is missing")
    client = _genai_client(settings.gemini_api_key)
    raw, _ = _decode_base64(image_base64)
    image_part = types.Part.from_bytes(data=raw, mime_type=mime_type or "image/jpeg")
    contents = [_get_system_prompt(), _get_user_prompt(ocr_snippets), image_part]
    # Fast mode: use gemini-2.5-flash-lite with thinking disabled — ~3-5s vs 15-20s for 2.5-flash
    fast_models = ["gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.5-flash"]
    model_list = fast_models if fast_mode else _candidate_gemini_models(client)

    # Thinking config: disable thinking for fast mode (saves 10-15s on 2.5-flash)
    thinking_cfg = None
    if fast_mode:
        try:
            thinking_cfg = types.ThinkingConfig(thinking_budget=0)
        except Exception:
            pass  # older SDK version — no ThinkingConfig, just use faster model

    last_err = None
    for model_name in model_list:
        for use_structured in (True, False):
            try:
                # 4096 (was 2048): with `thinking_budget=0` + structured/schema output, Gemini
                # 2.5 models sometimes still spend part of this same token pool on internal
                # "thinking" before emitting visible text — the visible JSON was getting cut off
                # well before 2048 tokens' worth of actual content, intermittently, depending on
                # how much the model "thought" first. More headroom fixes the truncation.
                if use_structured:
                    config = types.GenerateContentConfig(
                        temperature=0.1,
                        max_output_tokens=4096,
                        response_mime_type="application/json",
                        response_schema=ucp_schema,
                        **({"thinking_config": thinking_cfg} if thinking_cfg else {}),
                    )
                else:
                    config = types.GenerateContentConfig(
                        temperature=0.1,
                        max_output_tokens=4096,
                        **({"thinking_config": thinking_cfg} if thinking_cfg else {}),
                    )
                response = client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=config,
                )
                text = _extract_response_text(response)
                if not (text or "").strip():
                    raise VisionServiceError("Vision model returned empty output")
                try:
                    finish_reason = getattr(response.candidates[0], "finish_reason", None)
                    if finish_reason and str(finish_reason).upper() not in ("STOP", "1", "FINISHREASON.STOP"):
                        logger.warning(
                            "Gemini finish_reason=%s for model=%s (truncated/blocked output likely)",
                            finish_reason,
                            model_name,
                        )
                except Exception:
                    pass
                return _parse_extraction_response(text)
            except VisionServiceError as e:
                if use_structured:
                    logger.info(
                        "Gemini structured pass failed on %s (%s); trying free-form output",
                        model_name,
                        e,
                    )
                    continue
                raise
            except Exception as e:
                last_err = e
                if use_structured and _structured_schema_api_error(e):
                    logger.info(
                        "Gemini structured JSON not accepted on %s, falling back to free-form: %s",
                        model_name,
                        e,
                    )
                    continue
                err = str(e).lower()
                if use_structured:
                    # e.g. transient — try free-form on same model
                    continue
                if (
                    "not found" in err
                    or "404" in err
                    or ("model" in err and "invalid" in err)
                    or "no longer" in err
                    or "not available" in err
                ):
                    logger.info("Gemini model %s not available, trying next: %s", model_name, e)
                    break
                raise
    raise VisionServiceError(f"No available Gemini model for extraction: {last_err}")


async def extract_with_gemini(
    image_base64: str,
    mime_type: str,
    ocr_snippets: list[str],
    fast_mode: bool = False,
) -> VisionExtractionResponse:
    """Use Gemini for multimodal extraction. fast_mode uses gemini-2.0-flash with no thinking."""
    timeout = 15.0 if fast_mode else 120.0
    return await asyncio.wait_for(
        asyncio.to_thread(_gemini_extract_sync, image_base64, mime_type, ocr_snippets, fast_mode),
        timeout=timeout,
    )


async def extract_with_openai(
    image_base64: str,
    mime_type: str,
    ocr_snippets: list[str],
) -> VisionExtractionResponse:
    """Use GPT-4o for multimodal extraction (UCP when prompt available)."""
    from openai import AsyncOpenAI

    settings = get_settings()
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    raw, mime = _decode_base64(image_base64)
    b64_for_api = base64.b64encode(raw).decode("utf-8")

    user_content = [
        {"type": "text", "text": _get_user_prompt(ocr_snippets)},
        {
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64_for_api}"},
        },
    ]

    response = await client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": _get_system_prompt()},
            {"role": "user", "content": user_content},
        ],
        max_tokens=2048,
        temperature=0.1,
    )
    text = (response.choices[0].message.content or "").strip()
    return _parse_extraction_response(text)


async def run_vision_extraction(
    image_base64: str,
    mime_type: str = "image/jpeg",
    ocr_snippets: Optional[list[str]] = None,
    fast_mode: bool = False,
) -> VisionExtractionResponse:
    """Run extraction with configured provider (Gemini or OpenAI). Uses UCP prompt when available."""
    settings = get_settings()
    snippets = ocr_snippets or []
    if settings.vision_provider == "openai":
        return await extract_with_openai(image_base64, mime_type, snippets)
    return await extract_with_gemini(image_base64, mime_type, snippets, fast_mode=fast_mode)


# ---- Invoice / receipt extraction (all-in-one) ---------------------------------

INVOICE_EXTRACTION_SYSTEM = """You are a document data extractor. Extract structured data from invoice or receipt images.

Output ONLY valid JSON (no markdown). Use null for any field you cannot read clearly.

{
  "extraction_type": "invoice" or "receipt",
  "vendor_name": "Seller / merchant / company name",
  "vendor_address": "Full address if visible or null",
  "document_date": "YYYY-MM-DD if possible, or date as written",
  "due_date": "Payment due date if visible or null",
  "invoice_number": "Invoice or receipt number or null",
  "line_items": [
    { "description": "Item or service", "quantity": 1, "unit_price": 10.00, "amount": 10.00 }
  ],
  "subtotal": number or null,
  "tax": number or null,
  "total": number or null,
  "currency": "GBP" or "USD" etc,
  "raw_ocr_snippets": ["text snippets you used"],
  "confidence_score": 0.0 to 1.0
}

Rules:
- Copy numbers and names exactly from the document. For amounts, use numeric values only (no currency symbols in numbers).
- line_items: include every line you can read (description, quantity, unit_price, amount). amount = line total.
- If only one total is visible, put it in "total". Use subtotal/tax if clearly separated.
"""


def _parse_invoice_json(text: str, doc_type: str) -> InvoiceExtractionResponse:
    """Parse model output into InvoiceExtractionResponse."""
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```\s*$", "", text)
    text = text.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return InvoiceExtractionResponse(
            extraction_type=doc_type,
            raw_ocr_snippets=[],
            confidence_score=0.3,
        )
    if not isinstance(data, dict):
        data = {}
    items = []
    for row in data.get("line_items") or []:
        if isinstance(row, dict):
            items.append(InvoiceLineItem(
                description=str(row.get("description") or "").strip(),
                quantity=_float_or_none(row.get("quantity")) or 1.0,
                unit_price=_float_or_none(row.get("unit_price")),
                amount=_float_or_none(row.get("amount")),
            ))
        elif isinstance(row, (str, int, float)):
            items.append(InvoiceLineItem(description=str(row)))
    return InvoiceExtractionResponse(
        extraction_type=data.get("extraction_type") or doc_type,
        vendor_name=data.get("vendor_name"),
        vendor_address=data.get("vendor_address"),
        document_date=data.get("document_date"),
        due_date=data.get("due_date"),
        invoice_number=data.get("invoice_number"),
        line_items=items,
        subtotal=_float_or_none(data.get("subtotal")),
        tax=_float_or_none(data.get("tax")),
        total=_float_or_none(data.get("total")),
        currency=data.get("currency"),
        raw_ocr_snippets=data.get("raw_ocr_snippets") if isinstance(data.get("raw_ocr_snippets"), list) else [],
        confidence_score=float(data.get("confidence_score", 0.8)),
    )


async def run_invoice_extraction(
    image_base64: str,
    mime_type: str,
    ocr_snippets: list[str],
    extraction_type: str = "invoice",
) -> InvoiceExtractionResponse:
    """Run invoice/receipt extraction with Gemini or OpenAI."""
    settings = get_settings()
    doc_type = "receipt" if extraction_type == "receipt" else "invoice"
    ocr_block = "\n".join(ocr_snippets[:50]) if ocr_snippets else "No OCR text provided."
    user_prompt = f"""Extract data from this {doc_type} image. Use the OCR text below when present. Output only the JSON object.

OCR text:
{ocr_block}

Output ONLY the JSON object with extraction_type, vendor_name, document_date, invoice_number, line_items, subtotal, tax, total, currency, raw_ocr_snippets, confidence_score."""

    if settings.vision_provider == "openai" and settings.openai_api_key:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=settings.openai_api_key)
        raw, mime = _decode_base64(image_base64)
        b64_for_api = base64.b64encode(raw).decode("utf-8")
        response = await client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": INVOICE_EXTRACTION_SYSTEM},
                {"role": "user", "content": [
                    {"type": "text", "text": user_prompt},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64_for_api}"}},
                ]},
            ],
            max_tokens=2048,
            temperature=0.1,
        )
        text = (response.choices[0].message.content or "").strip()
        return _parse_invoice_json(text, doc_type)

    if settings.gemini_api_key:
        types = _genai_types()
        client = _genai_client(settings.gemini_api_key)
        raw, _ = _decode_base64(image_base64)
        image_part = types.Part.from_bytes(data=raw, mime_type=mime_type or "image/jpeg")
        for model_name in _candidate_gemini_models(client):
            try:
                response = await asyncio.to_thread(
                    lambda: client.models.generate_content(
                        model=model_name,
                        contents=[INVOICE_EXTRACTION_SYSTEM, user_prompt, image_part],
                        config=types.GenerateContentConfig(
                            temperature=0.1,
                            max_output_tokens=2048,
                        ),
                    )
                )
                text = _extract_response_text(response)
                return _parse_invoice_json(text, doc_type)
            except Exception as e:
                if "not found" in str(e).lower() or "404" in str(e).lower():
                    continue
                raise

    return InvoiceExtractionResponse(
        extraction_type=doc_type,
        raw_ocr_snippets=ocr_snippets[:20],
        confidence_score=0.3,
    )


async def get_synthetic_ocr(image_base64: str, mime_type: str = "image/jpeg") -> list[str]:
    """
    When Google Cloud Vision is not configured, use the VLM to list all text visible in the image.
    Gives the main extractor OCR-like input so brand and product name can be exact.
    """
    types = _genai_types()
    settings = get_settings()
    if not settings.gemini_api_key or settings.vision_provider == "openai":
        return []
    client = _genai_client(settings.gemini_api_key)
    raw, _ = _decode_base64(image_base64)
    image_part = types.Part.from_bytes(data=raw, mime_type=mime_type or "image/jpeg")
    prompt = """List every word, number, and phrase you can read from this product image. One item per line. Preserve exact spelling and capitalization. Include: brand names, product names, model numbers, labels, packaging text. No explanations—only the list."""
    try:
        for model_name in _candidate_gemini_models(client):
            try:
                response = await asyncio.wait_for(
                    asyncio.to_thread(
                        lambda: client.models.generate_content(
                            model=model_name,
                            contents=[prompt, image_part],
                            config=types.GenerateContentConfig(
                                temperature=0,
                                max_output_tokens=1024,
                            ),
                        )
                    ),
                    timeout=45,
                )
                text = _extract_response_text(response)
                lines = [s.strip() for s in text.splitlines() if s.strip()]
                return lines[:80]
            except Exception as e:
                err = str(e).lower()
                if "not found" in err or "404" in err:
                    continue
                raise
    except Exception:
        return []


class MultimodalProcessor:
    """
    UCP-aligned processor: product image + optional OCR -> structured extraction.
    Uses VLM (Gemini 2.0 Flash or GPT-4o) with Universal Commerce Protocol and
    schema.org/Product output: brand, exact_model, material_composition, weight_grams,
    dimensions, condition_score, and Fact-Feel-Proof copy.
    """

    async def process(
        self,
        image_base64: str,
        mime_type: str = "image/jpeg",
        ocr_snippets: Optional[list[str]] = None,
        fast_mode: bool = False,
    ) -> VisionExtractionResponse:
        return await run_vision_extraction(
            image_base64=image_base64,
            mime_type=mime_type,
            ocr_snippets=ocr_snippets or None,
            fast_mode=fast_mode,
        )


def get_dummy_extraction() -> VisionExtractionResponse:
    """
    Return a fixed extraction for demo/dummy runs when no Vision API key is configured.
    Lets you run the full flow: upload → extract → save as draft → list.
    """
    return VisionExtractionResponse(
        attributes=ExtractionAttributes(
            material="Cotton blend",
            color="Navy",
            weight="200g",
            dimensions="30 x 20 x 5 cm",
            brand="Demo Brand",
            make=None,
            model_year=None,
        ),
        extraction_copy=ExtractionCopy(
            seo_title="Demo Product – Sample Listing",
            description="This is a demo extraction. Add GEMINI_API_KEY or OPENAI_API_KEY in .env to get real AI extraction from your image.",
            bullet_points=[
                "Demo bullet 1 – connect Vision API for real extraction",
                "Demo bullet 2 – then Save as draft will use real data",
                "Demo bullet 3 – no API key needed to see the flow",
            ],
            description_fact_feel_proof=FactFeelProof(
                fact="Demo mode: no Vision API configured.",
                feel="You can still run the full flow end-to-end.",
                proof="Add an API key to get real product extraction from photos.",
            ),
        ),
        tags=ExtractionTags(
            category="Demo / Sample",
            search_keywords=["demo", "sample", "dummy run"],
        ),
        raw_ocr_snippets=[],
        confidence_score=0.5,
    )
