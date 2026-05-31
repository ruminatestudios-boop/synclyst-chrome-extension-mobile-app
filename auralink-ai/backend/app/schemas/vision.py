"""Vision API request/response: attributes, copy, tags. UCP + schema.org/Product aligned.
Also supports extraction_type for all-in-one: product | invoice | receipt."""
from pydantic import BaseModel, Field, ConfigDict
from typing import Optional
from enum import Enum


class ExtractionType(str, Enum):
    PRODUCT = "product"
    INVOICE = "invoice"
    RECEIPT = "receipt"


class ExtractionAttributes(BaseModel):
    """Structured product attributes from image + OCR (UCP + schema.org)."""
    material: Optional[str] = None
    color: Optional[str] = None
    weight: Optional[str] = None  # e.g. "200g", "1.5 kg" (display)
    dimensions: Optional[str] = None  # e.g. "10x20x5 cm"
    brand: Optional[str] = None
    # Make: manufacturer or parent brand when different from brand (e.g. vehicles, electronics). Often same as brand.
    make: Optional[str] = None
    # Model year or release year when visible on label/packaging (e.g. "2024", "2023", "SS24").
    model_year: Optional[str] = None
    # Price when visible on label/packaging
    price_display: Optional[str] = None  # e.g. "$19.99", "£12.50" exactly as shown
    price_value: Optional[float] = None  # numeric for calculations (no currency symbol)
    price_source: Optional[str] = None  # "found_in_image" | "web_average" | "ai_suggested" | "not_found"
    price_confidence: Optional[float] = Field(None, ge=0, le=1)
    # UCP / agentic extraction
    exact_model: Optional[str] = None
    material_composition: Optional[str] = None  # e.g. "100% Merino Wool, 180gsm"
    weight_grams: Optional[float] = None
    weight_source: Optional[str] = None  # "from_image" | "estimated"
    condition_score: Optional[float] = Field(None, ge=0, le=1)
    # Semantic condition for eBay/TikTok/Amazon: new, like_new, good, fair, for_parts
    condition: Optional[str] = None
    # Pass 1 raw arrays for variant cross-population
    detected_colors: Optional[list[str]] = None
    detected_sizes: Optional[list[str]] = None
    detected_materials: Optional[list[str]] = None
    product_type: Optional[str] = None


class FactFeelProof(BaseModel):
    """GEO: Fact–Feel–Proof structure for AI referrals."""
    fact: Optional[str] = None
    feel: Optional[str] = None
    proof: Optional[str] = None


class ExtractionCopy(BaseModel):
    """SEO and conversion copy; optional Fact-Feel-Proof for GEO."""
    seo_title: str = Field(..., max_length=200, description="SEO-optimized title")
    description: str = Field(default="", description="Full description (legacy; may be built from fact+feel+proof)")
    bullet_points: list[str] = Field(default_factory=list, max_length=10)
    description_fact_feel_proof: Optional[FactFeelProof] = None


class ExtractionTags(BaseModel):
    """Categorization and search keywords."""
    category: Optional[str] = None
    search_keywords: list[str] = Field(default_factory=list, max_length=30)


def _default_copy():
    return ExtractionCopy(seo_title="Product", description="", bullet_points=[])


class VisionExtractionResponse(BaseModel):
    """Full extraction result (UCP + schema.org/Product aligned)."""
    model_config = ConfigDict(populate_by_name=True)
    attributes: ExtractionAttributes = Field(default_factory=ExtractionAttributes)
    extraction_copy: ExtractionCopy = Field(default_factory=_default_copy)
    tags: ExtractionTags = Field(default_factory=ExtractionTags)
    raw_ocr_snippets: list[str] = Field(default_factory=list, description="Relevant OCR text used")
    confidence_score: float = Field(default=1.0, ge=0, le=1)
    # Optional per-field confidence: high | medium | low for brand, seo_title, exact_model
    confidence_per_field: Optional[dict] = Field(None, description="e.g. { \"brand\": \"high\", \"seo_title\": \"medium\" }")
    # Which fields were corrected from OCR or set from web (for UI badges)
    sources: Optional[dict] = Field(None, description="e.g. { \"brand\": \"ocr\", \"seo_title\": \"web\" }")
    ucp_version: Optional[str] = Field(None, description="Universal Commerce Protocol version")
    schema_context: Optional[str] = Field(None, description="e.g. https://schema.org/Product")
    price_from_web: Optional[bool] = Field(None, description="True when selling price was set from average across online retailers")
    price_range_display: Optional[str] = Field(None, description="e.g. '385-420' when average is from multiple listings (GBP)")


class VisionExtractionRequest(BaseModel):
    """Input for the extraction endpoint."""
    image_base64: str = Field(..., description="Base64-encoded image (with or without data URL prefix)")
    mime_type: str = Field(default="image/jpeg")
    include_ocr: bool = Field(default=True, description="Run OCR and merge into attributes/copy")
    skip_web_enrichment: bool = Field(default=False, description="Skip web lookup for faster response (e.g. mobile)")
    extraction_type: str = Field(
        default="product",
        description="Type of document to extract: product (listing), invoice, or receipt",
    )
    fast_mode: bool = Field(
        default=False,
        description="Use faster model (gemini-2.0-flash, no thinking) — ideal for reseller price checks",
    )


class FetchProductImagesRequest(BaseModel):
    """Input for fetching product image URLs from the web."""
    brand: str = Field(default="", description="Product brand")
    title: str = Field(default="", description="Product title")
    exact_model: Optional[str] = Field(None, description="Exact model name if known")
    reference_image_base64: Optional[str] = Field(
        default=None,
        description="Base64 image (with or without data URL prefix). Used to match the same photoshoot / PDP gallery.",
    )
    reference_image_mime_type: str = Field(
        default="image/jpeg",
        description="MIME type for reference_image_base64 when no data: prefix is present",
    )
    reference_image_url: Optional[str] = Field(
        default=None,
        description="Public https image URL to use as reference (server-side fetch). Alternative to reference_image_base64.",
    )


class ProxyImageJsonRequest(BaseModel):
    """POST body to fetch a remote image through the server (avoids huge query strings on GET)."""

    url: str = Field(..., min_length=10, description="Absolute http(s) image URL")


class OptimizeSeoRequest(BaseModel):
    """Input for AI SEO optimization of a listing."""
    title: str = Field(default="", description="Current product/page title")
    description: str = Field(default="", description="Current product description")
    category: str = Field(default="", description="Product category")
    vendor: str = Field(default="", description="Brand/vendor name")


class OptimizeSeoResponse(BaseModel):
    """AI-suggested SEO optimizations and analysis."""
    seo_title: str = Field(..., description="Optimised page title (≤60 chars for SERP display)")
    meta_description: str = Field(..., description="Optimised meta description (~155 chars for Google snippets)")
    analysis: str = Field(default="", description="Short summary of what was improved")
    improvements: list[str] = Field(default_factory=list, description="Bullet points of improvements")


# ---- All-in-one extraction: invoice / receipt ---------------------------------

class InvoiceLineItem(BaseModel):
    """Single line on an invoice or receipt."""
    description: str = Field(default="", description="Item or service description")
    quantity: float = Field(default=1.0)
    unit_price: Optional[float] = None
    amount: Optional[float] = None  # line total (quantity * unit_price if not given)


class InvoiceExtractionResponse(BaseModel):
    """Structured extraction from an invoice or receipt image."""
    extraction_type: str = Field(default="invoice", description="invoice | receipt")
    vendor_name: Optional[str] = Field(None, description="Seller / merchant / supplier name")
    vendor_address: Optional[str] = None
    document_date: Optional[str] = Field(None, description="Date on document (YYYY-MM-DD or as read)")
    due_date: Optional[str] = None
    invoice_number: Optional[str] = None
    line_items: list[InvoiceLineItem] = Field(default_factory=list)
    subtotal: Optional[float] = None
    tax: Optional[float] = None
    total: Optional[float] = None
    currency: Optional[str] = Field(None, description="e.g. GBP, USD")
    raw_ocr_snippets: list[str] = Field(default_factory=list)
    confidence_score: float = Field(default=1.0, ge=0, le=1)
