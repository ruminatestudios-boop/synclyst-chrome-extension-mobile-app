"""
eBay market-summary endpoint — used by reseller results page for re-search
(size selector, manual query override).
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from starlette.requests import Request

from app.auth import optional_verify_clerk
from app.config import get_settings
from app.routes.vision import _maybe_scan_quota_block

router = APIRouter()


class EbaySearchRequest(BaseModel):
    keywords: str


@router.post("", response_model=dict)
async def market_summary(
    req: EbaySearchRequest,
    http_request: Request,
    _auth: dict = Depends(optional_verify_clerk),
):
    """Re-run eBay market summary for a custom query (size override, manual search)."""
    from app.services.ebay_service import fetch_ebay_market_summary

    settings = get_settings()
    if not req.keywords.strip():
        return {"sold_count": 0, "active_count": 0, "comps_sold": [], "warnings": ["Empty query"]}

    try:
        m = await fetch_ebay_market_summary(
            app_id=settings.ebay_app_id,
            cert_id=settings.ebay_cert_id,
            gemini_api_key=settings.gemini_api_key,
            keywords=req.keywords.strip()[:140],
            skip_gemini_search=True,
        )
        return {
            "query": m.query,
            "sold_count": m.sold_count,
            "sold_avg": m.sold_avg,
            "sold_low": m.sold_low,
            "sold_high": m.sold_high,
            "active_count": m.active_count,
            "active_avg": m.active_avg,
            "sell_through_confidence": m.sell_through_confidence,
            "comps_sold": [c.__dict__ for c in m.comps_sold],
            "warnings": m.warnings,
        }
    except Exception as e:
        return {"sold_count": 0, "active_count": 0, "comps_sold": [], "warnings": [str(e)[:100]]}
