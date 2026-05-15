from __future__ import annotations

from pydantic import BaseModel, Field
from typing import Optional

from app.schemas.vision import VisionExtractionResponse


class ResellerScanRequest(BaseModel):
    image_base64: str = Field(..., description="Base64 image (with or without data URL prefix)")
    mime_type: str = Field(default="image/jpeg")
    include_ocr: bool = Field(default=True)
    skip_web_enrichment: bool = Field(default=True, description="Default true for speed in reseller scans")
    # Optional: used to compute profit/ROI
    purchase_price: Optional[float] = Field(default=None, ge=0)
    currency: str = Field(default="USD", description="Display currency (best-effort; eBay Finding often returns USD)")


class EbayCompOut(BaseModel):
    title: str
    price: float
    currency: str = "USD"
    url: str
    image_url: Optional[str] = None
    end_time: Optional[str] = None
    condition_display: Optional[str] = None


class EbayMarketOut(BaseModel):
    query: str
    sold_count: int = 0
    sold_avg: Optional[float] = None
    sold_low: Optional[float] = None
    sold_high: Optional[float] = None
    active_count: int = 0
    active_avg: Optional[float] = None
    sell_through_confidence: float = Field(default=0.0, ge=0, le=1)
    comps_sold: list[EbayCompOut] = Field(default_factory=list)
    comps_active: list[EbayCompOut] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ProfitEstimateOut(BaseModel):
    purchase_price: Optional[float] = None
    estimated_resale_price: Optional[float] = None
    estimated_fees: Optional[float] = None
    estimated_shipping: Optional[float] = None
    estimated_net_profit: Optional[float] = None
    estimated_roi_pct: Optional[float] = None


class ResellerAnalysisOut(BaseModel):
    recommendation: str = Field(..., description="buy | maybe | skip")
    summary: str
    demand_strength: str = Field(..., description="high | medium | low")
    estimated_sell_speed: str = Field(..., description="fast | medium | slow")
    resale_confidence: float = Field(default=0.0, ge=0, le=1)


class ResellerScanResponse(BaseModel):
    extraction: VisionExtractionResponse
    optimized_ebay_query: str
    clean_title: str
    ebay_market: EbayMarketOut
    profit: ProfitEstimateOut
    analysis: ResellerAnalysisOut

