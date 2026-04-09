import { NextRequest, NextResponse } from "next/server";
import { deferUntil } from "@/lib/deferUntil";
import { deleteShopifyPlatformTokens } from "@/lib/deleteShopifyPlatformTokens";
import { verifyShopifyJsonWebhook } from "@/lib/shopifyGdprRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const v = await verifyShopifyJsonWebhook(request);
  if (!v.ok) return v.response;

  const shop = String(v.payload.shop_domain || "");
  deferUntil(
    deleteShopifyPlatformTokens(shop).then((result) => {
      if (!result.ok) console.error("[gdpr/shop-redact] delete failed", result.error);
    })
  );

  return new NextResponse(null, { status: 200 });
}
