from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# eBay API endpoints
# ---------------------------------------------------------------------------
EBAY_FINDING_ENDPOINT = "https://svcs.ebay.com/services/search/FindingService/v1"
EBAY_OAUTH_ENDPOINT   = "https://api.ebay.com/identity/v1/oauth2/token"
EBAY_BROWSE_ENDPOINT  = "https://api.ebay.com/buy/browse/v1/item_summary/search"
EBAY_BROWSE_SCOPE     = "https://api.ebay.com/oauth/api_scope"


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class EbayComp:
    title: str
    price: float
    currency: str
    url: str
    image_url: Optional[str] = None
    end_time: Optional[str] = None
    condition_display: Optional[str] = None


@dataclass
class EbayMarketSummary:
    query: str
    sold_count: int
    sold_avg: Optional[float]
    sold_low: Optional[float]
    sold_high: Optional[float]
    active_count: int
    active_avg: Optional[float]
    sell_through_confidence: float  # 0..1
    comps_sold: list[EbayComp]
    comps_active: list[EbayComp]
    warnings: list[str]


# ---------------------------------------------------------------------------
# OAuth token cache (in-process; refreshes automatically on expiry)
# ---------------------------------------------------------------------------
@dataclass
class _TokenCache:
    access_token: str = ""
    expires_at: float = 0.0   # unix timestamp
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, compare=False, repr=False)

_token_cache = _TokenCache()


async def _get_oauth_token(app_id: str, cert_id: str) -> str:
    """Return a valid OAuth application token, refreshing if needed."""
    async with _token_cache._lock:
        # Leave 60s buffer before expiry
        if _token_cache.access_token and time.time() < _token_cache.expires_at - 60:
            return _token_cache.access_token

        credentials = base64.b64encode(f"{app_id}:{cert_id}".encode()).decode()
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                EBAY_OAUTH_ENDPOINT,
                headers={
                    "Authorization": f"Basic {credentials}",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={
                    "grant_type": "client_credentials",
                    "scope": EBAY_BROWSE_SCOPE,
                },
            )
            resp.raise_for_status()
            data = resp.json()

        token = data.get("access_token", "")
        expires_in = int(data.get("expires_in", 7200))
        _token_cache.access_token = token
        _token_cache.expires_at = time.time() + expires_in
        return token


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _safe_float(v: Any) -> Optional[float]:
    try:
        return None if v is None else float(v)
    except Exception:
        return None


def _pctile(sorted_vals: list[float], p: float) -> Optional[float]:
    if not sorted_vals:
        return None
    p = max(0.0, min(1.0, p))
    idx = int(round((len(sorted_vals) - 1) * p))
    return sorted_vals[idx]


def _confidence_from_counts(sold: int, active: int) -> float:
    if sold <= 0:
        return 0.0
    ratio = sold / max(1.0, float(active))
    sold_term = 1.0 - math.exp(-sold / 10.0)
    ratio_term = 1.0 - math.exp(-min(2.0, ratio))
    return float(max(0.0, min(1.0, 0.55 * sold_term + 0.45 * ratio_term)))


def _normalize_title(t: str) -> str:
    return " ".join((t or "").strip().split())


# ---------------------------------------------------------------------------
# Browse API  (active listings — OAuth)
# ---------------------------------------------------------------------------
async def _browse_search(
    *,
    token: str,
    keywords: str,
    limit: int = 20,
) -> list[EbayComp]:
    """Fetch active listings from the Browse API."""
    params = {
        "q": keywords,
        "limit": str(min(50, max(5, limit))),
        "filter": "buyingOptions:{FIXED_PRICE|AUCTION}",
    }
    async with httpx.AsyncClient(timeout=12.0) as client:
        resp = await client.get(
            EBAY_BROWSE_ENDPOINT,
            params=params,
            headers={
                "Authorization": f"Bearer {token}",
                "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()
        data = resp.json()

    comps: list[EbayComp] = []
    for item in data.get("itemSummaries") or []:
        title = _normalize_title(item.get("title") or "")
        if not title:
            continue
        price_obj = item.get("price") or {}
        price = _safe_float(price_obj.get("value"))
        if not price or price <= 0:
            continue
        currency = str(price_obj.get("currency") or "USD")
        url = str(item.get("itemWebUrl") or "").strip()
        image_url = None
        img = item.get("image") or item.get("thumbnailImages", [{}])[0] if item.get("thumbnailImages") else None
        if isinstance(img, dict):
            image_url = img.get("imageUrl") or None
        condition = item.get("condition") or None
        comps.append(EbayComp(
            title=title[:180],
            price=float(price),
            currency=currency,
            url=url,
            image_url=image_url,
            condition_display=str(condition) if condition else None,
        ))
    return comps


# ---------------------------------------------------------------------------
# Finding API  (sold / completed listings — App ID only)
# ---------------------------------------------------------------------------
def _extract_finding_items(payload: dict) -> list[dict]:
    try:
        r = payload["findCompletedItemsResponse"][0]
    except Exception:
        try:
            r = payload["findItemsByKeywordsResponse"][0]
        except Exception:
            return []
    sr = (r.get("searchResult") or [{}])[0] if isinstance(r.get("searchResult"), list) else (r.get("searchResult") or {})
    items = sr.get("item") or []
    return items if isinstance(items, list) else []


def _parse_finding_comp(item: dict) -> Optional[EbayComp]:
    def _first(v: Any) -> Any:
        return v[0] if isinstance(v, list) and v else v

    title = _normalize_title(str(_first(item.get("title")) or ""))
    if not title:
        return None

    url = str(_first(item.get("viewItemURL")) or "").strip()

    selling = _first(item.get("sellingStatus")) or {}
    cur_price = _first(selling.get("currentPrice")) or {}
    price = _safe_float(cur_price.get("__value__") if isinstance(cur_price, dict) else None)
    currency = str(cur_price.get("@currencyId") or "USD") if isinstance(cur_price, dict) else "USD"
    if price is None or price <= 0:
        return None

    end_time = None
    try:
        lt = _first(item.get("listingInfo")) or {}
        raw_end = _first(lt.get("endTime"))
        if raw_end:
            try:
                dt = datetime.fromisoformat(str(raw_end).replace("Z", "+00:00"))
                end_time = dt.astimezone(timezone.utc).isoformat()
            except Exception:
                end_time = str(raw_end)
    except Exception:
        pass

    cond = None
    try:
        c = _first(item.get("condition")) or {}
        cond_raw = _first(c.get("conditionDisplayName"))
        cond = str(cond_raw) if cond_raw else None
    except Exception:
        pass

    def _first_str(v: Any) -> Optional[str]:
        try:
            if isinstance(v, list):
                v = v[0] if v else None
            s = str(v or "").strip()
            return s or None
        except Exception:
            return None

    image_url = (
        _first_str(item.get("pictureURLSuperSize"))
        or _first_str(item.get("pictureURLLarge"))
        or _first_str(item.get("galleryURL"))
        or _first_str(item.get("galleryPlusPictureURL"))
    )

    return EbayComp(
        title=title[:180],
        price=float(price),
        currency=currency,
        url=url,
        image_url=image_url,
        end_time=end_time,
        condition_display=cond,
    )


async def _finding_sold(
    *,
    app_id: str,
    keywords: str,
    entries_per_page: int = 20,
) -> list[EbayComp]:
    """Fetch sold/completed items from the Finding API using App ID."""
    params: dict[str, Any] = {
        "OPERATION-NAME": "findCompletedItems",
        "SERVICE-VERSION": "1.13.0",
        "SECURITY-APPNAME": app_id,
        "RESPONSE-DATA-FORMAT": "JSON",
        "REST-PAYLOAD": "true",
        "keywords": keywords,
        "paginationInput.entriesPerPage": str(int(max(5, min(50, entries_per_page)))),
        "outputSelector(0)": "PictureURLLarge",
        "outputSelector(1)": "PictureURLSuperSize",
        "outputSelector(2)": "GalleryInfo",
        "itemFilter(0).name": "SoldItemsOnly",
        "itemFilter(0).value": "true",
        "itemFilter(1).name": "ListingType",
        "itemFilter(1).value(0)": "FixedPrice",
        "itemFilter(1).value(1)": "Auction",
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(EBAY_FINDING_ENDPOINT, params=params)
        r.raise_for_status()
        payload = r.json()

    items = [_parse_finding_comp(it) for it in _extract_finding_items(payload)]
    return [c for c in items if c is not None]


# ---------------------------------------------------------------------------
# Gemini + Google Search grounding fallback for sold comps
# ---------------------------------------------------------------------------

# Step 1 prompt: grounded web search for market pricing
_GEMINI_SEARCH_PROMPT = """Search Google for current resale market prices for: "{query}"

Look for:
- eBay active and sold listings prices
- Google Shopping prices
- Amazon prices
- Any reseller price guides or marketplace data

After searching, list the prices you found and their sources."""

# Step 2 prompt: structure the found data as JSON (built dynamically to avoid .format() issues)
# See _build_structure_prompt() below
_GEMINI_STRUCTURE_PROMPT_PREFIX = """Based on this market pricing data:

"""
_GEMINI_STRUCTURE_PROMPT_SUFFIX = """

Return ONLY a valid JSON object (no markdown, no explanation, no code fences):
{
  "sold_prices": [12.99, 15.00, 9.50],
  "comps": [
    {"title": "item title", "price": 12.99, "currency": "USD", "condition": "Used", "url": ""}
  ],
  "source_note": "brief note e.g. AI market estimate based on Google Shopping / eBay"
}

Rules:
- sold_prices: up to 8 price values in USD (numbers only, no symbols)
- comps: up to 5 items with realistic prices for "QUERY_PLACEHOLDER"
- If prices varied by condition, include both used and new prices
- If the search found no prices, use your knowledge of typical resale values for this item
- Always return real price numbers — never return empty arrays if you have any knowledge of this item's value
- source_note: mention data sources found (e.g. "Google Shopping, eBay active listings")
"""


def _build_structure_prompt(search_summary: str, query: str) -> str:
    """Build the structure prompt safely without .format() so curly braces in search_summary are safe."""
    suffix = _GEMINI_STRUCTURE_PROMPT_SUFFIX.replace("QUERY_PLACEHOLDER", query[:80])
    return _GEMINI_STRUCTURE_PROMPT_PREFIX + (search_summary or f"No web results found for '{query}'.") + suffix


def _parse_gemini_sold_response(text: str) -> tuple[list[float], list[EbayComp], str]:
    """Parse JSON from Gemini response, return (prices, comps, note)."""
    # Strip markdown code fences if present
    clean = re.sub(r"```(?:json)?\s*", "", text or "").strip().rstrip("`").strip()
    # Find first {...} block
    m = re.search(r"\{.*\}", clean, re.DOTALL)
    if not m:
        return [], [], "Could not parse Gemini response"
    try:
        data = json.loads(m.group())
    except Exception:
        return [], [], "JSON parse error"

    prices: list[float] = []
    for p in data.get("sold_prices") or []:
        v = _safe_float(p)
        if v and v > 0:
            prices.append(v)

    comps: list[EbayComp] = []
    for c in data.get("comps") or []:
        title = _normalize_title(str(c.get("title") or ""))
        price = _safe_float(c.get("price"))
        if not title or not price or price <= 0:
            continue
        comps.append(EbayComp(
            title=title[:180],
            price=float(price),
            currency=str(c.get("currency") or "USD"),
            url=str(c.get("url") or "").strip(),
            condition_display=str(c.get("condition") or "") or None,
        ))

    note = str(data.get("source_note") or "AI market estimate")
    return prices, comps, note


async def _gemini_sold_comps(
    *,
    gemini_api_key: str,
    keywords: str,
    max_comps: int = 5,
) -> tuple[list[float], list[EbayComp], str]:
    """
    Two-step Gemini approach:
      1. Use Google Search grounding to find real market prices.
      2. Pass grounded summary to a second call to structure it as JSON.
    Falls back to knowledge-only estimate if search returns nothing useful.
    """
    if not gemini_api_key:
        return [], [], ""
    try:
        import google.genai as genai
        from google.genai import types
    except ModuleNotFoundError:
        logger.warning("google-genai SDK not installed — Gemini sold comps unavailable")
        return [], [], ""

    q = keywords[:120]
    try:
        client = genai.Client(api_key=gemini_api_key)

        # ---- Step 1: grounded search to gather price data ----
        search_prompt = _GEMINI_SEARCH_PROMPT.format(query=q)
        tools = [types.Tool(google_search=types.GoogleSearch())]
        search_cfg = types.GenerateContentConfig(
            temperature=0.1,
            max_output_tokens=2048,
            tools=tools,
        )
        search_resp = await asyncio.to_thread(
            client.models.generate_content,
            model="gemini-2.5-flash",
            contents=search_prompt,
            config=search_cfg,
        )
        search_summary = (getattr(search_resp, "text", None) or "").strip()
        logger.debug("Gemini grounded search summary (%d chars): %s", len(search_summary), search_summary[:200])

        # ---- Step 2: structure as JSON (no tools — pure generation) ----
        # Even if search_summary is thin, the structure prompt asks Gemini
        # to use its own knowledge as a fallback, so we always get prices.
        # Built with safe concatenation — no .format() so curly braces in
        # the search summary can't cause KeyError/ValueError.
        structure_prompt = _build_structure_prompt(search_summary, q)
        struct_cfg = types.GenerateContentConfig(
            temperature=0.2,
            max_output_tokens=2048,
        )
        struct_resp = await asyncio.to_thread(
            client.models.generate_content,
            model="gemini-2.5-flash",
            contents=structure_prompt,
            config=struct_cfg,
        )
        json_text = (getattr(struct_resp, "text", None) or "").strip()
        if not json_text:
            return [], [], "No response from Gemini"

        prices, comps, note = _parse_gemini_sold_response(json_text)
        return prices[:8], comps[:max_comps], note

    except Exception as e:
        logger.warning("Gemini sold comps failed: %s", e)
        return [], [], f"Gemini search error: {str(e)[:80]}"


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
async def fetch_ebay_market_summary(
    *,
    app_id: str,
    keywords: str,
    cert_id: str = "",
    gemini_api_key: str = "",
    max_comps: int = 8,
) -> EbayMarketSummary:
    """
    Fetch sold + active comps for a keyword query.

    Strategy:
      - Active listings  → Browse API (OAuth, auto-refresh) if cert_id provided,
                           else Finding API findItemsByKeywords as fallback.
      - Sold listings    → Finding API findCompletedItems first;
                           if quota blocked, falls back to Gemini + Google Search grounding.
    """
    warnings: list[str] = []
    q = _normalize_title(keywords)[:140]
    if not q:
        return EbayMarketSummary(
            query="",
            sold_count=0, sold_avg=None, sold_low=None, sold_high=None,
            active_count=0, active_avg=None,
            sell_through_confidence=0.0,
            comps_sold=[], comps_active=[],
            warnings=["Missing keywords for eBay search."],
        )

    sold_comps: list[EbayComp] = []
    active_comps: list[EbayComp] = []
    gemini_sold_prices: list[float] = []

    # --- Sold comps: try Finding API first, fall back to Gemini Search ---
    # If no eBay App ID is configured, skip straight to Gemini+Google Search grounding.
    finding_blocked = not bool(app_id)
    if app_id:
        try:
            sold_comps = await _finding_sold(
                app_id=app_id,
                keywords=q,
                entries_per_page=max(10, max_comps * 3),
            )
        except httpx.HTTPStatusError as e:
            body = (e.response.text or "")[:2000].lower()
            if any(kw in body for kw in ("ratelimiter", "exceeded the number", "operation is allowed", "developer.access")):
                finding_blocked = True
            else:
                warnings.append(f"Could not fetch sold comps from eBay ({e.response.status_code}).")
        except Exception as e:
            finding_blocked = True
            logger.debug("Finding API sold comps error: %s", e)

    # Gemini fallback when Finding API is quota-blocked / unconfigured, or returned nothing
    if (finding_blocked or not sold_comps) and gemini_api_key:
        logger.info("Using Gemini Search grounding for sold comps: %s", q)
        g_prices, g_comps, g_note = await _gemini_sold_comps(
            gemini_api_key=gemini_api_key,
            keywords=q,
            max_comps=max_comps,
        )
        if g_comps or g_prices:
            sold_comps = g_comps
            gemini_sold_prices = g_prices
            warnings.append(f"Sold prices via AI Search ({g_note})")
        elif finding_blocked:
            warnings.append(
                "eBay sold comps unavailable — Finding API quota not yet active. "
                "Complete the Application Growth Check at developer.ebay.com/my/keys."
            )

    # --- Active listings (Browse API preferred, Finding API fallback) ---
    # Skip entirely when no eBay App ID is configured.
    if app_id:
        try:
            if cert_id:
                token = await _get_oauth_token(app_id=app_id, cert_id=cert_id)
                active_comps = await _browse_search(
                    token=token,
                    keywords=q,
                    limit=max(10, max_comps * 2),
                )
            else:
                # Fallback: Finding API findItemsByKeywords
                params: dict[str, Any] = {
                    "OPERATION-NAME": "findItemsByKeywords",
                    "SERVICE-VERSION": "1.13.0",
                    "SECURITY-APPNAME": app_id,
                    "RESPONSE-DATA-FORMAT": "JSON",
                    "REST-PAYLOAD": "true",
                    "keywords": q,
                    "paginationInput.entriesPerPage": str(max(10, max_comps * 2)),
                    "outputSelector(0)": "PictureURLLarge",
                    "itemFilter(0).name": "ListingType",
                    "itemFilter(0).value(0)": "FixedPrice",
                    "itemFilter(0).value(1)": "Auction",
                }
                async with httpx.AsyncClient(timeout=10.0) as client:
                    r = await client.get(EBAY_FINDING_ENDPOINT, params=params)
                    r.raise_for_status()
                    active_items = [_parse_finding_comp(it) for it in _extract_finding_items(r.json())]
                    active_comps = [c for c in active_items if c is not None]
        except Exception as e:
            warnings.append(f"eBay active listings error: {str(e)[:120]}")

    # --- Enrich sold comps with images from Browse API ---
    # Gemini comps have no image_url.  Reuse real eBay CDN images from active
    # listings (same product category, same query) so cards show actual photos.
    if active_comps:
        active_images = [c.image_url for c in active_comps if c.image_url]
        if active_images:
            img_idx = 0
            for sc in sold_comps:
                if not sc.image_url:
                    sc.image_url = active_images[img_idx % len(active_images)]
                    img_idx += 1

    # --- Aggregate ---
    # Use Gemini-extracted prices if richer than comp prices alone
    comp_prices = [c.price for c in sold_comps]
    sold_prices = sorted(gemini_sold_prices if len(gemini_sold_prices) > len(comp_prices) else (comp_prices or gemini_sold_prices))
    active_prices = sorted([c.price for c in active_comps])

    sold_count = len(sold_prices)
    active_count = len(active_prices)
    sold_avg = (sum(sold_prices) / sold_count) if sold_count else None
    active_avg = (sum(active_prices) / active_count) if active_count else None

    if sold_count >= 5:
        low = _pctile(sold_prices, 0.2)
        high = _pctile(sold_prices, 0.8)
    else:
        low = sold_prices[0] if sold_prices else None
        high = sold_prices[-1] if sold_prices else None

    conf = _confidence_from_counts(sold_count, active_count)

    if sold_count == 0 and active_count == 0:
        warnings.append("No eBay data found. Try a broader or simpler search term.")
    elif sold_count == 0:
        warnings.append("No sold comps found — using active listings for price estimate.")

    return EbayMarketSummary(
        query=q,
        sold_count=sold_count,
        sold_avg=sold_avg,
        sold_low=low,
        sold_high=high,
        active_count=active_count,
        active_avg=active_avg,
        sell_through_confidence=conf,
        comps_sold=sold_comps[:max_comps],
        comps_active=active_comps[:max_comps],
        warnings=warnings,
    )
