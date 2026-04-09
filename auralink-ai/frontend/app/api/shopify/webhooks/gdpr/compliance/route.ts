import { NextRequest, NextResponse } from "next/server";
import { deleteShopifyPlatformTokens } from "@/lib/deleteShopifyPlatformTokens";
import {
  readShopifyWebhookHeaders,
  verifyShopifyWebhookHmac,
} from "@/lib/shopifyWebhook";
import { normalizeMyshopifyDomain } from "@/lib/publishingJwt";

export const runtime = "nodejs";

/**
 * Single URL for all mandatory compliance topics (matches `shopify.app.toml`).
 * Shopify automated checks often validate against the same host as `application_url` (synclyst.app).
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const { hmac } = readShopifyWebhookHeaders(request.headers);

  if (!verifyShopifyWebhookHmac({ rawBody, hmacHeader: hmac })) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const topic = (request.headers.get("x-shopify-topic") || "").trim();
  const shopFromHeader = (request.headers.get("x-shopify-shop-domain") || "").trim();

  try {
    switch (topic) {
      case "app/uninstalled": {
        const p = payload as { domain?: string; shop_domain?: string };
        const shop = shopFromHeader || String(p.domain || p.shop_domain || "");
        const result = await deleteShopifyPlatformTokens(shop);
        if (!result.ok) {
          console.error("[gdpr/compliance] app/uninstalled token delete failed", result.error);
          return NextResponse.json({ error: "Uninstall cleanup failed" }, { status: 500 });
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
          return NextResponse.json({ error: "Redaction failed" }, { status: 500 });
        }
        break;
      }
      default:
        console.warn("[gdpr/compliance] unknown topic", topic);
    }
  } catch (e) {
    console.error("[gdpr/compliance] handler error", topic, e);
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return new NextResponse(null, { status: 200 });
}
