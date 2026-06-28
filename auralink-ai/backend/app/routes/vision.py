"""
Vision extraction: MultimodalProcessor → UCP/schema.org attributes, Fact-Feel-Proof copy.
"""
from __future__ import annotations

import asyncio
import base64
import logging
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, Response
from starlette.requests import Request
from pydantic import ValidationError
import httpx

from app.auth import optional_verify_clerk
from app.config import get_settings
from app.db import (
    get_supabase,
    get_scan_usage_unified,
    consume_one_scan,
    is_valid_anon_uuid,
    get_ip_scan_count,
    increment_ip_scan,
    starter_monthly_limit,
)
from app.schemas.vision import (
    VisionExtractionRequest,
    VisionExtractionResponse,
    FetchProductImagesRequest,
    OptimizeSeoRequest,
    OptimizeSeoResponse,
    ProxyImageJsonRequest,
)
from app.schemas.reseller import ResellerScanRequest, ResellerScanResponse
from app.services.vision_service import (
    MultimodalProcessor,
    get_synthetic_ocr,
    get_dummy_extraction,
    apply_post_extraction,
    apply_blocklist_and_ocr_validation,
    apply_normalizer,
    apply_verification_pass,
    run_invoice_extraction,
    VisionServiceError,
)
from app.services.ocr_service import (
    run_ocr_google,
    run_ocr_tesseract,
    enrich_attributes_from_ocr,
    extract_dimensions_from_ocr,
)
from app.services.ebay_service import fetch_ebay_market_summary
from app.services.web_enrichment import enrich_from_web
from app.services.product_images import fetch_product_image_urls, load_reference_image_bytes
from app.services.seo_optimize import optimize_seo_listing

logger = logging.getLogger(__name__)

router = APIRouter()
_processor = MultimodalProcessor()


def _get_client_ip(request: Request) -> str:
    """
    Real client IP — respects X-Forwarded-For set by Cloud Run / GCP load balancer.
    The left-most entry is the original client; subsequent entries are proxies.
    """
    forwarded = (
        request.headers.get("x-forwarded-for") or
        request.headers.get("X-Forwarded-For") or ""
    ).strip()
    if forwarded:
        return forwarded.split(",")[0].strip()
    return (request.client.host if request.client else "unknown") or "unknown"


def _consume_scan(supabase, qk: str, http_request: Request) -> None:
    """Consume one scan against the anon quota AND the IP daily counter."""
    consume_one_scan(supabase, qk)
    # Also tick the IP counter so other browsers on the same network
    # share the same daily budget and can't bypass by clearing cookies.
    if qk and qk.startswith("anon:"):
        ip = _get_client_ip(http_request)
        increment_ip_scan(supabase, ip)


def _resolve_quota_key(http_request: Request, _auth: dict | None) -> str | None:
    settings = get_settings()
    sub = (_auth or {}).get("sub") if _auth else None
    if sub and sub != "dev":
        return str(sub)
    if not settings.clerk_secret_key and sub == "dev":
        return "dev"
    raw = (
        http_request.headers.get("X-SyncLyst-Anon-Id") or http_request.headers.get("x-synclyst-anon-id") or ""
    ).strip()
    if is_valid_anon_uuid(raw):
        return f"anon:{raw}"
    return None


_RESELLER_FAST_PROMPT = """You are a resale product scanner used by resellers at markets and thrift stores. Look at this image and return ONLY a JSON object:
{
  "brand": "exact brand name or null — check ALL visible text, tags, logos, even faded/worn ones",
  "model": "exact model name or product line or null",
  "product_type": "e.g. T-Shirt, Sneakers, Denim Jacket, Hoodie, etc.",
  "color": "main color or null",
  "condition": "New / Like New / Good / Fair / Poor based on visible wear, fading, stains",
  "seo_title": "concise resale title under 80 chars, e.g. Carhartt Detroit Jacket Brown XL",
  "ebay_price_estimate": estimated resale price range on eBay as [low, high] numbers in USD, or null,
  "depop_price_estimate": estimated resale price on Depop/Vinted (often 1.5-3x eBay for fashion/vintage) as [low, high] or null,
  "identification_confidence": "high / medium / low — how confident are you in the brand/model identification"
}
IMPORTANT: Even for worn, faded, or vintage items — look carefully at all labels, stitching, hardware, logos. Output ONLY the JSON."""


async def _fast_reseller_extract(image_b64: str, mime: str) -> dict:
    """
    Lightweight Gemini call for reseller scans only.
    Uses gemini-2.5-flash-lite + thinking_budget=0 + small image + simple prompt.
    Target: 2-4s vs 14-20s for full UCP pipeline.
    """
    import json as _json
    from google import genai as _genai
    from google.genai import types as _types

    settings = get_settings()
    if not settings.gemini_api_key:
        return {}

    # Resize aggressively for speed — 480px is plenty to read labels/logos
    small_b64 = _resize_image_if_large(image_b64, mime, max_px=480, max_bytes=150_000)

    client = _genai.Client(api_key=settings.gemini_api_key)
    try:
        raw = base64.b64decode(small_b64 + "==")
    except Exception:
        raw = base64.b64decode(image_b64.split(",", 1)[-1] + "==")

    image_part = _types.Part.from_bytes(data=raw, mime_type=mime)

    try:
        thinking_cfg = _types.ThinkingConfig(thinking_budget=0)
    except Exception:
        thinking_cfg = None

    config_kwargs = dict(temperature=0.1, max_output_tokens=512)
    if thinking_cfg:
        config_kwargs["thinking_config"] = thinking_cfg

    # Try flash-lite first, fall back to 2.5-flash
    for model in ["gemini-2.5-flash-lite", "gemini-2.5-flash"]:
        try:
            resp = await asyncio.wait_for(
                asyncio.to_thread(
                    client.models.generate_content,
                    model=model,
                    contents=[_RESELLER_FAST_PROMPT, image_part],
                    config=_types.GenerateContentConfig(**config_kwargs),
                ),
                timeout=12.0,
            )
            text = (getattr(resp, "text", None) or "").strip()
            # Strip markdown code fences if present
            text = text.lstrip("```json").lstrip("```").rstrip("```").strip()
            data = _json.loads(text)
            if isinstance(data, dict):
                return data
        except asyncio.TimeoutError:
            logger.info("Fast reseller extract timed out on %s", model)
        except Exception as e:
            logger.debug("Fast reseller extract error (%s): %s", model, e)
    return {}


def _maybe_scan_quota_block(http_request: Request, _auth: dict | None) -> JSONResponse | None:
    supabase = get_supabase()
    if not supabase:
        return None
    qk = _resolve_quota_key(http_request, _auth)
    if not qk:
        if get_settings().clerk_secret_key:
            return JSONResponse(
                status_code=400,
                content={
                    "detail": "Missing X-SyncLyst-Anon-Id header for guest scans. Refresh the page or update the app.",
                },
            )
        return None
    usage = get_scan_usage_unified(supabase, qk)
    if not usage.get("can_scan", True):
        return JSONResponse(
            status_code=402,
            content={
                "detail": "Scan limit reached. Buy scan credits or try again tomorrow.",
                "scans_limit": int(usage.get("scans_limit", 10)),
                "quota_window": str(usage.get("quota_window", "daily")),
                "bonus_credits": int(usage.get("bonus_credits") or 0),
            },
        )
    # IP-based rate limit: applies to free guest scans only (not paid credits).
    # Prevents multi-browser abuse — every browser on the same IP shares one pool.
    if qk.startswith("anon:"):
        bonus = int(usage.get("bonus_credits") or 0)
        if bonus == 0:  # Paid credits bypass the IP check
            client_ip = _get_client_ip(http_request)
            ip_count = get_ip_scan_count(supabase, client_ip)
            daily_limit = starter_monthly_limit()
            if ip_count >= daily_limit:
                return JSONResponse(
                    status_code=402,
                    content={
                        "detail": "Scan limit reached. Buy scan credits or try again tomorrow.",
                        "scans_limit": daily_limit,
                        "quota_window": "daily",
                        "bonus_credits": 0,
                    },
                )
    return None


def _decode_base64(image_base64: str) -> bytes:
    data = image_base64.strip()
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    return base64.b64decode(data, validate=True)


def _resize_image_if_large(image_base64: str, mime: str, max_px: int = 720, max_bytes: int = 350_000) -> str:
    """Resize image to max_px on longest side and re-encode as JPEG for faster vision API calls. Returns base64."""
    try:
        raw = _decode_base64(image_base64)
        payload = image_base64.split(",", 1)[-1].strip() if image_base64.strip().startswith("data:") else image_base64.strip()
        if len(raw) <= max_bytes:
            try:
                from PIL import Image
                import io
                img = Image.open(io.BytesIO(raw))
                w, h = img.size
                if max(w, h) <= max_px:
                    return payload
            except Exception:
                return payload
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(raw))
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        w, h = img.size
        if max(w, h) <= max_px and len(raw) <= max_bytes:
            return payload
        scale = max_px / max(w, h)
        new_w, new_h = int(round(w * scale)), int(round(h * scale))
        img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("utf-8")
    except Exception as e:
        logger.debug("Resize image skip: %s", e)
    return image_base64.split(",", 1)[-1].strip() if image_base64.strip().startswith("data:") else image_base64.strip()


def _build_clean_title_and_query(extraction: dict) -> tuple[str, str]:
    """
    Build a clean marketplace title and an eBay-friendly query from the vision extraction.
    Prioritize speed and usefulness over perfect match.
    """
    att = extraction.get("attributes") or {}
    copy = extraction.get("extraction_copy") or extraction.get("copy") or {}
    tags = extraction.get("tags") or {}
    brand = (att.get("brand") or "").strip()
    product_type = (att.get("product_type") or tags.get("category") or "").strip()
    color = (att.get("color") or "").strip()
    exact_model = (att.get("exact_model") or "").strip()
    year = (att.get("model_year") or "").strip()
    title = (copy.get("seo_title") or "").strip()
    kw = tags.get("search_keywords") or []
    kw = [str(x).strip() for x in kw if x is not None and str(x).strip()]

    # Clean title: prefer existing seo_title if it's not generic.
    clean_parts: list[str] = []
    if title and title.lower() not in ("product", "item from photo", "item"):
        clean_parts.append(title)
    else:
        for p in (brand, product_type, exact_model, color):
            if p and p.lower() not in ("unknown", "n/a"):
                clean_parts.append(p)
        if not clean_parts and kw:
            clean_parts.append(kw[0])
    clean_title = " ".join(clean_parts).strip()[:160] or "Item from photo"

    # eBay query: use seo_title when it contains the brand and specific model info,
    # since it's more descriptive than assembling from generic fields alone.
    # This prevents "Represent t-shirt black" when the title says
    # "Represent Great Ocean Road Tour Graphic Tee Black".
    _generic = {"unknown", "n/a", "product", "item from photo", "item"}
    title_has_brand = brand and title and brand.lower() in title.lower()
    title_has_model = exact_model and title and exact_model.lower() in title.lower()
    title_is_specific = (
        title
        and title.lower() not in _generic
        and (title_has_brand or title_has_model)
        # seo_title must add something beyond just brand + type
        and len(title.split()) > 2
    )
    if title_is_specific:
        # Use the seo_title (up to 8 words) — it already encodes brand + specific model.
        query = " ".join(title.split()[:8]).strip()[:140]
    else:
        query_parts: list[str] = []
        for p in (brand, exact_model, product_type, color, year):
            if p and p.lower() not in _generic:
                query_parts.append(p)
        # Add extra keywords for specificity.
        for k in kw[:6]:
            if len(query_parts) >= 6:
                break
            kl = k.lower()
            if any(kl == q.lower() for q in query_parts):
                continue
            if brand and kl == brand.lower():
                continue
            query_parts.append(k)
        query = " ".join(query_parts).strip()[:140] or clean_title[:140]
    return clean_title, query


def _estimate_profit(
    *,
    purchase_price: float | None,
    estimated_resale_price: float | None,
    fee_rate: float,
    payment_rate: float,
    payment_fixed: float,
    shipping_default: float,
) -> dict:
    if estimated_resale_price is None or estimated_resale_price <= 0:
        return {
            "purchase_price": purchase_price,
            "estimated_resale_price": None,
            "estimated_fees": None,
            "estimated_shipping": None,
            "estimated_net_profit": None,
            "estimated_roi_pct": None,
        }
    fees = max(0.0, estimated_resale_price * float(fee_rate))
    payment = max(0.0, estimated_resale_price * float(payment_rate) + float(payment_fixed))
    est_shipping = max(0.0, float(shipping_default))
    total_cost = fees + payment + est_shipping + (float(purchase_price) if purchase_price is not None else 0.0)
    net = float(estimated_resale_price) - total_cost
    roi = None
    if purchase_price is not None and purchase_price > 0:
        roi = (net / float(purchase_price)) * 100.0
    return {
        "purchase_price": purchase_price,
        "estimated_resale_price": float(estimated_resale_price),
        "estimated_fees": round(fees + payment, 2),
        "estimated_shipping": round(est_shipping, 2),
        "estimated_net_profit": round(net, 2),
        "estimated_roi_pct": round(roi, 1) if roi is not None else None,
    }


def _reseller_analysis_from_market(
    *,
    sold_count: int,
    sell_through_confidence: float,
    est_profit: float | None,
    roi_pct: float | None,
) -> dict:
    # Demand
    if sold_count >= 12 and sell_through_confidence >= 0.6:
        demand = "high"
        speed = "fast"
    elif sold_count >= 5:
        demand = "medium"
        speed = "medium"
    else:
        demand = "low"
        speed = "slow"

    # Recommendation
    rec = "maybe"
    if est_profit is not None:
        if est_profit >= 20 and (roi_pct is None or roi_pct >= 120):
            rec = "buy"
        elif est_profit <= 5:
            rec = "skip"
    else:
        # no purchase price: base on confidence + range
        if sell_through_confidence >= 0.65 and sold_count >= 8:
            rec = "buy"
        elif sold_count <= 1:
            rec = "skip"

    if rec == "buy":
        summary = "Strong flip potential with healthy margins and consistent sold history."
    elif rec == "skip":
        summary = "Likely not worth reselling due to weak demand or thin margins after fees."
    else:
        summary = "Moderate resale potential — verify the exact model and condition for better comps."

    return {
        "recommendation": rec,
        "summary": summary,
        "demand_strength": demand,
        "estimated_sell_speed": speed,
        "resale_confidence": float(max(0.0, min(1.0, sell_through_confidence))),
    }


@router.post("/reseller-scan", response_model=ResellerScanResponse)
async def reseller_scan(
    http_request: Request,
    rs: ResellerScanRequest,
    _auth: dict = Depends(optional_verify_clerk),
):
    """
    Reseller Intelligence Scanner:
    - Vision identification (reuses existing stack)
    - eBay sold/active comps (Finding API)
    - Profit/ROI estimate (fast heuristics)
    - Short reseller-focused recommendation
    """
    from app.config import get_settings

    settings = get_settings()

    mime = rs.mime_type or "image/jpeg"

    # FAST PATH: lightweight Gemini call — simple prompt, 480px image, no thinking tokens.
    # Skips the entire UCP pipeline (OCR, web enrichment, verification, normalizer).
    # Target: 3-5s total (vision ~2-3s + eBay ~1-2s).
    fast_data = await _fast_reseller_extract(rs.image_base64, mime)

    # Convert the lightweight extraction into the dict shape the rest of the code expects
    raw_b64 = _resize_image_if_large(rs.image_base64, mime)
    id_conf = fast_data.get("identification_confidence", "medium")
    conf_score = 0.9 if id_conf == "high" else 0.65 if id_conf == "medium" else 0.4
    extraction = {
        "attributes": {
            "brand": fast_data.get("brand"),
            "product_type": fast_data.get("product_type"),
            "color": fast_data.get("color"),
            "condition": fast_data.get("condition"),
            "exact_model": fast_data.get("model"),
        },
        "extraction_copy": {
            "seo_title": fast_data.get("seo_title") or fast_data.get("model") or "",
        },
        "tags": {
            "category": fast_data.get("product_type"),
            "search_keywords": [k for k in [
                fast_data.get("brand"), fast_data.get("model"), fast_data.get("product_type")
            ] if k],
        },
        "confidence_score": conf_score if fast_data else 0.0,
        "identification_confidence": id_conf,
        "platform_estimates": {
            "ebay": fast_data.get("ebay_price_estimate"),
            "depop_vinted": fast_data.get("depop_price_estimate"),
        },
    }

    # Build eBay query immediately from vision result — no barcode lookup needed
    # (OCR is disabled for reseller fast mode so there are no raw_ocr_snippets anyway).
    clean_title, ebay_query = _build_clean_title_and_query(extraction)

    # Guard: if the query looks like an OCR/vision error string, skip eBay and return a clear warning.
    _OCR_ERROR_PREFIXES = (
        "i am sorry", "the image", "i cannot", "i can't", "i'm sorry",
        "no text", "unable to", "could not", "it looks like", "this image",
        "the photo", "there is no", "unfortunately",
    )
    _query_lower = ebay_query.lower().strip()
    _query_is_junk = (
        any(_query_lower.startswith(p) for p in _OCR_ERROR_PREFIXES)
        or (len(ebay_query) > 80 and sum(1 for w in ebay_query.split() if len(w) > 2) < 3)
        or ebay_query == "Item from photo"
    )

    # FAST MODE: skip Gemini grounded search (saves 5-18s).
    # Go straight to eBay Finding API — 1-3s for real sold comps.
    # Gemini fallback only fires if eBay is rate-limited AND skip_gemini_search=False.
    if _query_is_junk:
        market = {
            "query": ebay_query,
            "sold_count": 0,
            "sold_avg": None,
            "sold_low": None,
            "sold_high": None,
            "active_count": 0,
            "active_avg": None,
            "sell_through_confidence": 0.0,
            "comps_sold": [],
            "comps_active": [],
            "warnings": ["Could not identify the product clearly enough to search for prices. Try a clearer photo with the item label visible."],
        }
    else:
        try:
            m = await fetch_ebay_market_summary(
                app_id=settings.ebay_app_id,
                cert_id=settings.ebay_cert_id,
                gemini_api_key=settings.gemini_api_key,
                keywords=ebay_query,
                skip_gemini_search=True,  # FAST: skip 5-18s Gemini grounded search
            )
            market = {
                "query": m.query,
                "sold_count": m.sold_count,
                "sold_avg": m.sold_avg,
                "sold_low": m.sold_low,
                "sold_high": m.sold_high,
                "active_count": m.active_count,
                "active_avg": m.active_avg,
                "sell_through_confidence": m.sell_through_confidence,
                "comps_sold": [c.__dict__ for c in m.comps_sold],
                "comps_active": [c.__dict__ for c in m.comps_active],
                "warnings": m.warnings,
            }
        except Exception as e:
            logger.warning("eBay market lookup failed: %s", e)
            ebay_warning = "Could not reach eBay comps right now. Try again."
            if isinstance(e, httpx.HTTPStatusError) and e.response is not None:
                body = (e.response.text or "")[:2000]
                lower_body = body.lower()
                if (
                    "ratelimiter" in lower_body
                    or "exceeded the number of times" in lower_body
                    or "operation is allowed" in lower_body
                ):
                    ebay_warning = (
                        "eBay key is connected, but Finding API quota is not active yet. "
                        "Wait for eBay quota propagation or complete Application Growth Check."
                    )
            market = {
                "query": ebay_query,
                "sold_count": 0,
                "sold_avg": None,
                "sold_low": None,
                "sold_high": None,
                "active_count": 0,
                "active_avg": None,
                "sell_through_confidence": 0.0,
                "comps_sold": [],
                "comps_active": [],
                "warnings": [ebay_warning],
            }

    # Choose a resale anchor price for profit estimates:
    # 1) Sold average, else sold high (small sample), else active average
    # 2) Fallback to price detected in image (if any)
    est_resale = market.get("sold_avg") or market.get("sold_high") or market.get("active_avg")
    if not est_resale:
        try:
            att = (extraction.get("attributes") or {}) if isinstance(extraction, dict) else {}
            pv = att.get("price_value")
            if isinstance(pv, (int, float)) and pv and pv > 0:
                est_resale = float(pv)
                market_w = market.get("warnings") or []
                if isinstance(market_w, list):
                    market_w.append("Using price detected in image as a resale estimate (no comps available).")
                    market["warnings"] = market_w
        except Exception:
            pass
    profit = _estimate_profit(
        purchase_price=rs.purchase_price,
        estimated_resale_price=est_resale,
        fee_rate=settings.reseller_fee_rate,
        payment_rate=settings.reseller_payment_rate,
        payment_fixed=settings.reseller_payment_fixed,
        shipping_default=settings.reseller_shipping_default,
    )
    analysis = _reseller_analysis_from_market(
        sold_count=int(market.get("sold_count") or 0),
        sell_through_confidence=float(market.get("sell_through_confidence") or 0.0),
        est_profit=profit.get("estimated_net_profit"),
        roi_pct=profit.get("estimated_roi_pct"),
    )

    # Count this scan once for authenticated users (extract() increments too; avoid double-count by only incrementing here when extract did not)
    # NOTE: extract() already increments for product path when user_id + supabase, so we don't increment again.

    return {
        "extraction": extraction,
        "optimized_ebay_query": ebay_query,
        "clean_title": clean_title,
        "ebay_market": market,
        "profit": profit,
        "analysis": analysis,
    }

@router.post("/extract")
async def extract(
    http_request: Request,
    vreq: VisionExtractionRequest,
    _auth: dict = Depends(optional_verify_clerk),
):
    """
    Extract from one image. Supports extraction_type: product (listing), invoice, or receipt.
    Product: returns attributes, extraction_copy, tags (UCP + schema.org/Product).
    Invoice/Receipt: returns vendor_name, document_date, line_items, total, currency, etc.
    """
    settings = get_settings()
    raw_b64 = vreq.image_base64
    mime = vreq.mime_type or "image/jpeg"
    extraction_type = (vreq.extraction_type or "product").strip().lower()

    blocked = _maybe_scan_quota_block(http_request, _auth)
    if blocked:
        return blocked

    # Invoice / receipt path
    if extraction_type in ("invoice", "receipt"):
        raw_b64 = _resize_image_if_large(raw_b64, mime)
        ocr_snippets = []
        raw_bytes = b""
        if vreq.include_ocr:
            try:
                raw_bytes = _decode_base64(raw_b64)
            except Exception:
                pass
            if raw_bytes:
                try:
                    ocr_snippets = await run_ocr_google(raw_bytes)
                except Exception:
                    pass
                if not ocr_snippets:
                    ocr_snippets = await asyncio.to_thread(run_ocr_tesseract, raw_bytes)
                if not ocr_snippets:
                    ocr_snippets = await get_synthetic_ocr(raw_b64, mime)
        # Be defensive: downstream helpers expect a list.
        ocr_snippets = ocr_snippets or []
        use_dummy = bool(getattr(settings, "force_dummy_vision", False))
        if use_dummy:
            from app.schemas.vision import InvoiceExtractionResponse, InvoiceLineItem
            dummy = InvoiceExtractionResponse(
                extraction_type=extraction_type,
                vendor_name="Demo Vendor",
                document_date="2025-01-15",
                invoice_number="INV-001",
                line_items=[
                    InvoiceLineItem(description="Sample item", quantity=1, unit_price=29.99, amount=29.99),
                ],
                subtotal=29.99,
                tax=0,
                total=29.99,
                currency="GBP",
                confidence_score=0.5,
            )
            supabase = get_supabase()
            qk = _resolve_quota_key(http_request, _auth)
            if qk and supabase:
                _consume_scan(supabase, qk, http_request)
            return dummy.model_dump()
        if settings.vision_provider == "gemini" and not bool(settings.gemini_api_key):
            raise HTTPException(
                status_code=503,
                detail="Vision API not configured. Set GEMINI_API_KEY in backend .env to use invoice extraction.",
            )
        if settings.vision_provider == "openai" and not bool(settings.openai_api_key):
            raise HTTPException(
                status_code=503,
                detail="Vision API not configured. Set OPENAI_API_KEY in backend .env to use invoice extraction.",
            )
        try:
            result = await asyncio.wait_for(
                run_invoice_extraction(raw_b64, mime, ocr_snippets, extraction_type),
                timeout=120.0,
            )
        except asyncio.TimeoutError:
            raise HTTPException(
                status_code=504,
                detail="Invoice extraction timed out. Try a clearer or smaller image, then retry.",
            ) from None
        except Exception as e:
            logger.warning("Invoice extraction failed: %s", e)
            raise HTTPException(
                status_code=503,
                detail=f"Invoice extraction failed: {e}",
            ) from None
        supabase = get_supabase()
        qk = _resolve_quota_key(http_request, _auth)
        if qk and supabase:
            _consume_scan(supabase, qk, http_request)
        return result.model_dump()

    # Product path (existing)
    has_gemini = bool(settings.gemini_api_key)
    has_openai = bool(settings.openai_api_key)
    use_dummy = bool(getattr(settings, "force_dummy_vision", False))
    if use_dummy:
        supabase = get_supabase()
        qk = _resolve_quota_key(http_request, _auth)
        if qk and supabase:
            _consume_scan(supabase, qk, http_request)
        return get_dummy_extraction().model_dump()
    if settings.vision_provider == "gemini" and not has_gemini:
        raise HTTPException(
            status_code=503,
            detail="Vision API not configured. Set GEMINI_API_KEY in backend .env to use image extraction.",
        )
    if settings.vision_provider == "openai" and not has_openai:
        raise HTTPException(
            status_code=503,
            detail="Vision API not configured. Set OPENAI_API_KEY in backend .env.",
        )

    raw_b64 = vreq.image_base64
    mime = vreq.mime_type or "image/jpeg"
    ocr_snippets: list[str] = []
    raw_bytes: bytes = b""

    # Resize early so OCR and vision both run on smaller image (faster, especially on mobile)
    raw_b64 = _resize_image_if_large(raw_b64, mime)

    if vreq.include_ocr:
        async def _run_ocr_with_timeout() -> list[str]:
            out: list[str] = []
            try:
                raw_bytes = _decode_base64(raw_b64)
            except Exception:
                return out
            if not raw_bytes:
                return out
            try:
                out = await asyncio.wait_for(
                    run_ocr_google(raw_bytes),
                    timeout=25.0,
                )
            except asyncio.TimeoutError:
                logger.warning("Google OCR timed out after 25s")
            except Exception as e:
                logger.warning("Google OCR failed: %s", e)
            if not out and raw_bytes:
                try:
                    out = await asyncio.wait_for(
                        asyncio.to_thread(run_ocr_tesseract, raw_bytes),
                        timeout=20.0,
                    )
                except asyncio.TimeoutError:
                    logger.warning("Tesseract OCR timed out after 20s")
                except Exception as e:
                    logger.warning("Tesseract OCR failed: %s", e)
            if not out:
                try:
                    out = await asyncio.wait_for(
                        get_synthetic_ocr(raw_b64, mime),
                        timeout=15.0,
                    )
                except asyncio.TimeoutError:
                    logger.warning("Synthetic OCR timed out after 15s")
                except Exception as e:
                    logger.warning("Synthetic OCR failed: %s", e)
            return out or []

        try:
            ocr_snippets = await asyncio.wait_for(_run_ocr_with_timeout(), timeout=45.0)
        except asyncio.TimeoutError:
            logger.warning("OCR step timed out, continuing with empty snippets")
            ocr_snippets = []
    # Be defensive: downstream helpers expect a list.
    ocr_snippets = ocr_snippets or []

    # Already resized above for both OCR and vision. Main Gemini call has 120s timeout inside processor.
    try:
        result = await _processor.process(
            image_base64=raw_b64,
            mime_type=mime,
            ocr_snippets=ocr_snippets or None,
            fast_mode=getattr(vreq, "fast_mode", False),
        )
    except asyncio.TimeoutError:
        logger.warning("Vision extraction timed out (Gemini >120s)")
        raise HTTPException(
            status_code=504,
            detail="Extraction took too long. Try a smaller or simpler image, or try again in a moment.",
        ) from None
    except ValidationError as e:
        logger.warning("Vision extraction validation error: %s", e)
        raise HTTPException(
            status_code=503,
            detail="Vision extraction returned invalid structured data. Please retry with a clearer image.",
        ) from None
    except VisionServiceError as e:
        logger.warning("Vision extraction upstream error: %s", e)
        err_msg = str(e) if e is not None else ""
        lower_err = err_msg.lower()
        # Graceful fallback: never block the user on rate limits / quota.
        # Return a safe extraction so the user can edit manually in flow-3.
        if "429" in err_msg or "quota" in lower_err or "resource exhausted" in lower_err or "rate limit" in lower_err:
            from app.services.vision_service import get_fallback_extraction
            fallback = get_fallback_extraction()
            fallback.extraction_copy.seo_title = "Item from photo"
            fallback.extraction_copy.description = "AI is temporarily unavailable (rate limited). Please review and edit this draft before publishing."
            fallback.confidence_score = 0.2
            fallback.sources = {**(fallback.sources or {}), "fallback": "quota"}
            supabase = get_supabase()
            qk = _resolve_quota_key(http_request, _auth)
            if qk and supabase:
                _consume_scan(supabase, qk, http_request)
            return fallback.model_dump()
        raise HTTPException(status_code=503, detail=err_msg) from None
    except Exception as e:
        logger.exception("Vision extraction failed")
        s = settings
        if not s.gemini_api_key and s.vision_provider != "openai":
            raise HTTPException(
                status_code=503,
                detail="Vision API not configured. Set GEMINI_API_KEY in backend .env to use image extraction.",
            )
        if not s.openai_api_key and s.vision_provider == "openai":
            raise HTTPException(
                status_code=503,
                detail="Vision API not configured. Set OPENAI_API_KEY in backend .env.",
            )
        err_msg = str(e)
        lower_err = err_msg.lower()
        is_key_error = (
            "api_key_invalid" in lower_err
            or "api key not valid" in lower_err
            or ("403" in err_msg and "invalid argument" not in lower_err)
            or ("permission denied" in lower_err and "api key" in lower_err)
        )
        if is_key_error:
            raise HTTPException(
                status_code=503,
                detail="Gemini API key invalid or restricted. Check GEMINI_API_KEY in backend .env and ensure the Generative Language API is enabled in Google Cloud / AI Studio.",
            )
        if "429" in err_msg or "quota" in lower_err or "resource exhausted" in lower_err or "rate limit" in lower_err:
            from app.services.vision_service import get_fallback_extraction
            fallback = get_fallback_extraction()
            fallback.extraction_copy.seo_title = "Item from photo"
            fallback.extraction_copy.description = "AI is temporarily unavailable (rate limited). Please review and edit this draft before publishing."
            fallback.confidence_score = 0.2
            fallback.sources = {**(fallback.sources or {}), "fallback": "quota"}
            supabase = get_supabase()
            qk = _resolve_quota_key(http_request, _auth)
            if qk and supabase:
                _consume_scan(supabase, qk, http_request)
            return fallback.model_dump()
        raise HTTPException(status_code=500, detail=f"Extraction failed: {err_msg}")

    # Enrich material/brand from OCR (material phrases, brands_db) if not already set
    mat, brand = enrich_attributes_from_ocr(
        ocr_snippets,
        current_material=result.attributes.material,
        current_brand=result.attributes.brand,
    )
    if mat and not result.attributes.material:
        result.attributes.material = mat
    if brand and not result.attributes.brand:
        result.attributes.brand = brand

    # Blocklist generic output + OCR-first overwrite when VLM disagrees or is generic
    result = apply_blocklist_and_ocr_validation(result, ocr_snippets)
    result = apply_normalizer(result)

    # Optional verification pass: text-only consistency check (Gemini). Cap at 30s so total route stays within frontend timeout.
    if ocr_snippets and settings.gemini_api_key:
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(apply_verification_pass, result, ocr_snippets, settings.gemini_api_key),
                timeout=30.0,
            )
        except asyncio.TimeoutError:
            logger.debug("Verification pass timed out, using draft as-is")
        except Exception as e:
            logger.debug("Verification pass skipped: %s", e)

    # Dimensions from OCR when VLM did not extract
    if not result.attributes.dimensions and ocr_snippets:
        dims = extract_dimensions_from_ocr(ocr_snippets)
        if dims:
            result.attributes.dimensions = dims
            if result.sources is None:
                result.sources = {}
            result.sources["dimensions"] = "ocr"

    result.raw_ocr_snippets = ocr_snippets[:20]

    result = apply_post_extraction(result)

    # If category looks like "BRAND > Type", ensure brand is set for web enrichment
    if not result.attributes.brand and result.tags.category and ">" in result.tags.category:
        result.attributes.brand = result.tags.category.split(">")[0].strip()

    # Internet-backed enrichment: fetch exact product name and full listing details from the web.
    # Hard-capped at 10 s so a slow Google search never blocks the whole response.
    if not vreq.skip_web_enrichment and settings.enable_web_enrichment and settings.gemini_api_key:
        try:
            result = await asyncio.wait_for(enrich_from_web(result, settings), timeout=10.0)
        except asyncio.TimeoutError:
            logger.warning("Web enrichment timed out after 10 s — using image-only result")
        except Exception as e:
            logger.warning("Web enrichment failed (using image-only result): %s", e)

    supabase = get_supabase()
    qk = _resolve_quota_key(http_request, _auth)
    if qk and supabase:
        _consume_scan(supabase, qk, http_request)

    # Return as dict to avoid FastAPI re-validating and triggering "copy" validation errors
    return result.model_dump()


@router.post("/fetch-product-images")
async def fetch_product_images(
    request: FetchProductImagesRequest,
    _auth: dict = Depends(optional_verify_clerk),
):
    """
    Search the web for product image URLs (official/retailer). When a reference image is sent,
    prefer the same listing gallery / photoshoot as that photo—not unrelated stock images.
    """
    from app.config import get_settings

    settings = get_settings()
    if not settings.gemini_api_key:
        raise HTTPException(
            status_code=503,
            detail="Product image search is not configured. Set GEMINI_API_KEY in backend .env.",
        )
    brand = (request.brand or "").strip()
    title = (request.title or "").strip()
    ref_bytes, ref_mime = await asyncio.to_thread(
        load_reference_image_bytes,
        (request.reference_image_base64 or "").strip() or None,
        (request.reference_image_url or "").strip() or None,
        (request.reference_image_mime_type or "image/jpeg").strip() or "image/jpeg",
    )
    if not title and not brand and not ref_bytes:
        return {"image_urls": []}
    urls = await fetch_product_image_urls(
        brand=brand,
        title=title,
        exact_model=request.exact_model if request.exact_model else None,
        gemini_api_key=settings.gemini_api_key,
        reference_image_bytes=ref_bytes,
        reference_image_mime_type=ref_mime,
    )
    return {"image_urls": urls}


@router.post("/optimize-seo", response_model=OptimizeSeoResponse)
async def optimize_seo(
    request: OptimizeSeoRequest,
    _auth: dict = Depends(optional_verify_clerk),
):
    """
    Analyse the product title and description and return AI-optimised SEO title and meta description,
    plus a short analysis and list of improvements. Uses Gemini when GEMINI_API_KEY is set.
    """
    from app.config import get_settings
    settings = get_settings()
    result = await optimize_seo_listing(
        title=request.title or "",
        description=request.description or "",
        category=request.category or "",
        vendor=request.vendor or "",
        gemini_api_key=settings.gemini_api_key or "",
    )
    return OptimizeSeoResponse(
        seo_title=result["seo_title"],
        meta_description=result["meta_description"],
        analysis=result.get("analysis") or "",
        improvements=result.get("improvements") or [],
    )


# Common browser User-Agent so CDNs (Nike, Amazon, etc.) don't block the proxy
PROXY_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def _proxy_url_allowed(url: str) -> bool:
    """SSRF check: only allow http(s) and block localhost/private IPs."""
    try:
        parsed = urlparse(url.strip())
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return False
        host = (parsed.hostname or "").lower()
        if host in ("localhost", "127.0.0.1") or host.startswith("192.168.") or host.startswith("10.") or host.startswith("169.254."):
            return False
        return True
    except Exception:
        return False


def _sniff_image_media_type(body: bytes) -> str | None:
    """Return image/* from magic bytes when Content-Type is wrong or generic."""
    if not body or len(body) < 12:
        return None
    if body[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if body[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "image/webp"
    if body[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def _referer_candidates_for_image_url(url: str) -> list[str]:
    """
    Many retailer CDNs require a storefront Referer. Try several so thumbnails load in the UI.
    """
    parsed = urlparse(url.strip())
    scheme = parsed.scheme or "https"
    netloc = (parsed.netloc or "").lower()
    host = (parsed.hostname or "").lower()
    origin = f"{scheme}://{parsed.netloc}/"
    candidates: list[str] = []
    if "media-amazon" in host or "ssl-images-amazon" in host or "images-amazon" in host:
        candidates.append("https://www.amazon.com/")
    if "ebayimg" in host or host.endswith(".ebaystatic.com"):
        candidates.append("https://www.ebay.com/")
    if "etsy" in host:
        candidates.append("https://www.etsy.com/")
    if "shopify" in host or "cdn.shopify.com" in host:
        candidates.append(origin)
    if "tiktokcdn" in host or "tiktok" in host:
        candidates.append("https://www.tiktok.com/")
    candidates.append(origin)
    candidates.append("https://www.google.com/")
    seen: set[str] = set()
    out: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


async def _fetch_upstream_image(url: str) -> tuple[bytes, str]:
    """GET image bytes with retailer-friendly Referer; retry on 401/403."""
    clean = url.strip()
    base_headers = {
        "User-Agent": PROXY_USER_AGENT,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
    }
    last_status: int | None = None
    async with httpx.AsyncClient(follow_redirects=True, timeout=20.0) as client:
        for ref in _referer_candidates_for_image_url(clean):
            ref_p = urlparse(ref)
            origin = f"{ref_p.scheme}://{ref_p.netloc}" if ref_p.netloc else ""
            headers = {**base_headers, "Referer": ref}
            if origin:
                headers["Origin"] = origin
            try:
                r = await client.get(clean, headers=headers)
            except httpx.RequestError as e:
                logger.warning("Proxy image request error for %s: %s", clean[:80], e)
                raise HTTPException(status_code=502, detail="Could not fetch image") from e
            if r.status_code in (401, 403):
                last_status = r.status_code
                continue
            try:
                r.raise_for_status()
            except httpx.HTTPStatusError as e:
                sc = e.response.status_code if e.response is not None else 0
                if sc in (401, 403):
                    last_status = sc
                    continue
                raise HTTPException(status_code=sc, detail="Upstream image unavailable") from e

            body = r.content
            if not body or len(body) < 32:
                logger.warning("Proxy image: empty or tiny body for %s", clean[:60])
                raise HTTPException(status_code=502, detail="URL did not return an image")

            ct = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
            if "image/" in ct:
                return body, ct
            if "octet-stream" in ct or "binary" in ct:
                sniffed = _sniff_image_media_type(body)
                if sniffed:
                    return body, sniffed
            sniffed = _sniff_image_media_type(body)
            if sniffed:
                return body, sniffed
            logger.warning("Proxy image: upstream non-image content-type %s for %s", ct, clean[:60])
            raise HTTPException(status_code=502, detail="URL did not return an image")

    if last_status is not None:
        raise HTTPException(status_code=last_status, detail="Upstream image unavailable")
    raise HTTPException(status_code=502, detail="Could not fetch image")


async def _proxy_image_bytes_response(url: str) -> Response:
    if not url or not url.strip():
        raise HTTPException(status_code=400, detail="Missing image URL")
    if not _proxy_url_allowed(url):
        raise HTTPException(status_code=400, detail="URL not allowed")
    try:
        body, media_type = await _fetch_upstream_image(url)
        return Response(
            content=body,
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=3600"},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Proxy image failed for %s: %s", url[:80], e)
        raise HTTPException(status_code=502, detail="Could not fetch image") from e


@router.get("/proxy-image")
async def proxy_image(url: str = ""):
    """
    Fetch an image from the given URL and return it. Used so the frontend can display
    product images that would otherwise be blocked by CORS (e.g. official brand CDNs).
    """
    if not url or not url.strip():
        raise HTTPException(status_code=400, detail="Missing url query parameter")
    return await _proxy_image_bytes_response(url)


@router.post("/proxy-image")
async def proxy_image_post(request: ProxyImageJsonRequest):
    """Same as GET proxy-image but URL in JSON body (needed for very long CDN URLs)."""
    return await _proxy_image_bytes_response(request.url.strip())
