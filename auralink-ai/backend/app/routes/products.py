"""
Universal product CRUD and channel adapter storage.
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.schemas.product import UniversalProductCreate, UniversalProductResponse, ChannelAdapterRecord
from app.schemas.vision import VisionExtractionResponse
from app.db import get_supabase, create_product, get_product, list_products, get_shopify_store, get_valid_shopify_access_token, upsert_description_variation, list_shopify_stores
from app.demo_store import create_product_demo, get_product_demo, list_products_demo
from app.auth import verify_clerk, optional_verify_clerk

router = APIRouter()


class SyncShopifyRequest(BaseModel):
    shop_domain: str
    as_draft: bool = False


class PushDraftsRequest(BaseModel):
    """Select platforms to push this product to as draft. Seller reviews on each platform then pushes live."""
    channels: list[str] = ["shopify"]  # e.g. ["shopify", "amazon"]; only connected/implemented ones are used
    as_draft: bool = True


def _is_missing_table_error(e: Exception) -> bool:
    msg = str(e).lower()
    return "does not exist" in msg or "pgrst200" in msg or "schema cache" in msg or "undefined table" in msg


@router.post("", response_model=dict)
async def create_universal_product(payload: UniversalProductCreate, _auth: dict = Depends(verify_clerk)):
    """
    Create a master product in Universal_Products and return id.
    When DB is not configured (demo mode), uses in-memory store.
    """
    supabase = get_supabase()
    if supabase:
        try:
            row = create_product(supabase, payload)
            product_id = str(row["id"])
            from app.config import get_settings
            from app.services.ucp_manifest import build_and_upsert_ucp_manifest
            build_and_upsert_ucp_manifest(supabase, product_id, get_settings().app_base_url)
            return {"id": product_id, "created_at": row["created_at"]}
        except Exception as e:
            if _is_missing_table_error(e):
                import traceback
                print(f"[products] universal_products table missing — using demo store. Run migrations in Supabase dashboard.\n{traceback.format_exc()}", flush=True)
                row = create_product_demo(payload)
                return {"id": row["id"], "created_at": row["created_at"], "demo": True}
            raise HTTPException(status_code=400, detail=str(e))
    # Demo mode: in-memory store
    row = create_product_demo(payload)
    return {"id": row["id"], "created_at": row["created_at"], "demo": True}


@router.get("/{product_id}", response_model=UniversalProductResponse)
async def get_universal_product(product_id: UUID, _auth: dict = Depends(verify_clerk)):
    """Get master profile and channel adapters. Uses demo store when DB not configured."""
    supabase = get_supabase()
    if supabase:
        try:
            row = get_product(supabase, str(product_id))
        except Exception as e:
            if _is_missing_table_error(e):
                row = get_product_demo(str(product_id))
            else:
                raise HTTPException(status_code=500, detail=str(e))
    else:
        row = get_product_demo(str(product_id))
    if not row:
        raise HTTPException(status_code=404, detail="Product not found")
    adapters = [
        ChannelAdapterRecord(channel=a["channel"], external_id=a["external_id"], synced_at=a.get("synced_at"))
        for a in (row.get("channel_adapters") or [])
    ]
    return UniversalProductResponse(
        id=row["id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        attributes_material=row.get("attributes_material"),
        attributes_color=row.get("attributes_color"),
        attributes_weight=row.get("attributes_weight"),
        attributes_dimensions=row.get("attributes_dimensions"),
        attributes_brand=row.get("attributes_brand"),
        copy_seo_title=row["copy_seo_title"],
        copy_description=row["copy_description"],
        copy_bullet_points=row.get("copy_bullet_points") or [],
        tags_category=row.get("tags_category"),
        tags_search_keywords=row.get("tags_search_keywords") or [],
        image_url=row.get("image_url"),
        image_urls=row.get("image_urls") or [],
        status=row["status"],
        source_image_id=row.get("source_image_id"),
        channel_adapters=adapters,
    )


@router.get("", response_model=list)
async def list_universal_products(limit: int = 50, offset: int = 0, _auth: dict = Depends(optional_verify_clerk)):
    """List master products (for Control Center). Uses demo store when DB not configured."""
    supabase = get_supabase()
    if supabase:
        try:
            return list_products(supabase, limit=limit, offset=offset)
        except Exception as e:
            if _is_missing_table_error(e):
                return list_products_demo(limit=limit, offset=offset)
            raise HTTPException(status_code=503, detail=f"Database list failed: {str(e)}")
    return list_products_demo(limit=limit, offset=offset)


@router.post("/from-extraction", response_model=dict)
async def create_product_from_extraction(extraction: VisionExtractionResponse, _auth: dict = Depends(optional_verify_clerk)):
    """
    One-shot: create a Universal Product from a Vision extraction result.
    When DB not configured (demo mode), saves to in-memory store only.
    """
    payload = UniversalProductCreate(
        attributes_material=extraction.attributes.material,
        attributes_color=extraction.attributes.color,
        attributes_weight=extraction.attributes.weight,
        attributes_dimensions=extraction.attributes.dimensions,
        attributes_brand=extraction.attributes.brand,
        exact_model=extraction.attributes.exact_model,
        material_composition=extraction.attributes.material_composition,
        weight_grams=extraction.attributes.weight_grams,
        condition_score=extraction.attributes.condition_score,
        copy_seo_title=extraction.extraction_copy.seo_title,
        copy_description=extraction.extraction_copy.description,
        copy_bullet_points=extraction.extraction_copy.bullet_points,
        tags_category=extraction.tags.category,
        tags_search_keywords=extraction.tags.search_keywords,
        status="DRAFT",
    )
    response = await create_universal_product(payload)
    product_id = response["id"]
    supabase = get_supabase()
    if supabase and extraction.extraction_copy.description_fact_feel_proof:
        ffp = extraction.extraction_copy.description_fact_feel_proof
        copy_fact_feel_proof = {
            "fact": (ffp.fact or "") if hasattr(ffp, "fact") else (ffp.get("fact") or ""),
            "feel": (ffp.feel or "") if hasattr(ffp, "feel") else (ffp.get("feel") or ""),
            "proof": (ffp.proof or "") if hasattr(ffp, "proof") else (ffp.get("proof") or ""),
        }
        if copy_fact_feel_proof.get("fact") or copy_fact_feel_proof.get("feel") or copy_fact_feel_proof.get("proof"):
            upsert_description_variation(
                supabase,
                product_id=product_id,
                variation_type="SHOPIFY_META",
                copy_seo_title=extraction.extraction_copy.seo_title,
                copy_description=extraction.extraction_copy.description,
                copy_bullet_points=extraction.extraction_copy.bullet_points,
                copy_fact_feel_proof=copy_fact_feel_proof,
            )
        from app.config import get_settings
        from app.services.ucp_manifest import build_and_upsert_ucp_manifest
        build_and_upsert_ucp_manifest(supabase, product_id, get_settings().app_base_url)
    return response


@router.post("/{product_id}/sync/shopify", response_model=dict)
async def trigger_sync_to_shopify(product_id: UUID, body: SyncShopifyRequest, _auth: dict = Depends(verify_clerk)):
    """Queue sync of product to Shopify. In demo mode (no DB), returns a dummy success."""
    supabase = get_supabase()
    if not supabase:
        return {"task_id": "demo", "status": "demo_mode", "message": "No database connected. Use real Supabase + Shopify to sync."}
    row = get_product(supabase, str(product_id))
    if not row:
        raise HTTPException(status_code=404, detail="Product not found")
    shop = body.shop_domain.strip().lower()
    if not shop.endswith(".myshopify.com"):
        shop = f"{shop}.myshopify.com"
    store = get_shopify_store(supabase, shop)
    if not store:
        raise HTTPException(status_code=400, detail=f"Shopify store {shop} not connected. Connect via /api/v1/shopify/install?shop={shop}")
    access_token, err = get_valid_shopify_access_token(supabase, shop)
    if err or not access_token:
        raise HTTPException(status_code=400, detail=err or "Could not get valid access token")
    from app.tasks.sync_tasks import sync_to_shopify
    task = sync_to_shopify.delay(str(product_id), shop, access_token, as_draft=body.as_draft)
    return {"task_id": task.id, "status": "queued", "shop_domain": shop, "as_draft": body.as_draft}


@router.post("/{product_id}/push-drafts", response_model=dict)
async def push_to_drafts(product_id: UUID, body: PushDraftsRequest, _auth: dict = Depends(optional_verify_clerk)):
    """
    Push this product to the drafts section on each selected platform.
    In demo mode (no DB), returns a dummy success so you can see the flow.
    """
    supabase = get_supabase()
    if not supabase:
        row = get_product_demo(str(product_id))
        if not row:
            raise HTTPException(status_code=404, detail="Product not found")
        return {"status": "demo_mode", "product_id": str(product_id), "message": "No database connected. Connect Supabase and Shopify to push to stores.", "queued": []}
    row = get_product(supabase, str(product_id))
    if not row:
        raise HTTPException(status_code=404, detail="Product not found")
    queued: list[dict] = []
    if "shopify" in body.channels:
        stores = list_shopify_stores(supabase)
        for store in stores:
            shop_domain = store.get("shop_domain")
            if not shop_domain:
                continue
            access_token, err = get_valid_shopify_access_token(supabase, shop_domain)
            if err or not access_token:
                continue
            from app.tasks.sync_tasks import sync_to_shopify
            task = sync_to_shopify.delay(str(product_id), shop_domain, access_token, as_draft=body.as_draft)
            queued.append({"channel": "shopify", "shop_domain": shop_domain, "task_id": task.id})
    if not queued:
        raise HTTPException(
            status_code=400,
            detail="No connected stores for selected channels. Connect Shopify above, or select at least one channel you have connected.",
        )
    return {"status": "queued", "product_id": str(product_id), "as_draft": body.as_draft, "queued": queued}
