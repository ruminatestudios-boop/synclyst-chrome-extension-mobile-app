import { NextRequest, NextResponse } from "next/server";
import { deferUntil } from "@/lib/deferUntil";
import { deleteShopifyPlatformTokens } from "@/lib/deleteShopifyPlatformTokens";
import { verifyShopifyJsonWebhook } from "@/lib/shopifyGdprRequest";
import { normalizeMyshopifyDomain } from "@/lib/publishingJwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleComplianceSideEffects(
  topic: string,
  payload: Record<string, unknown>,
  shopFromHeader: string
): Promise<void> {
  switch (topic) {
    case "app/uninstalled": {
      const p = payload as { domain?: string; shop_domain?: string };
      const shop = shopFromHeader || String(p.domain || p.shop_domain || "");
      const result = await deleteShopifyPlatformTokens(shop);
      if (!result.ok) {
        console.error("[gdpr/compliance] app/uninstalled token delete failed", result.error);
      }
      break;
    }
    case "customers/data_request": {
      const shop = normalizeMyshopifyDomain(String(payload.shop_domain || ""));
      const customerId = (payload.customer as { id?: number } | undefined)?.id;
      console.log(
        "[gdpr/compliance] customers/data_request shop=%s customer_id=%s",
        shop || "?",
        customerId ?? "?"
      );
      break;
    }
    case "customers/redact":
      break;
    case "shop/redact": {
      const shop = String(payload.shop_domain || "");
      const result = await deleteShopifyPlatformTokens(shop);
      if (!result.ok) {
        console.error("[gdpr/compliance] shop/redact failed", result.error);
      }
      break;
    }
    default:
      console.warn("[gdpr/compliance] unknown topic", topic);
  }
}

/**
 * Single URL for mandatory compliance + app/uninstalled (shopify.app.toml).
 * Respond 200 quickly — Shopify enforces ~5s timeout; DB work runs via waitUntil on Vercel.
 */
export async function POST(request: NextRequest) {
  const v = await verifyShopifyJsonWebhook(request);
  if (!v.ok) return v.response;

  deferUntil(
    handleComplianceSideEffects(v.topic, v.payload, v.shopFromHeader).catch((e) => {
      console.error("[gdpr/compliance] async handler error", v.topic, e);
    })
  );

  return new NextResponse(null, { status: 200 });
}
