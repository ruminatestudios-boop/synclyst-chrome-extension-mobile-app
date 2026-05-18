import { NextRequest, NextResponse } from "next/server";
import {
  isShopifyWebhookSecretConfigured,
  readShopifyWebhookHeaders,
  verifyShopifyWebhookHmac,
} from "@/lib/shopifyWebhook";

export type VerifiedShopifyJsonWebhook =
  | {
      ok: true;
      rawBuf: Buffer;
      topic: string;
      shopFromHeader: string;
      payload: Record<string, unknown>;
    }
  | { ok: false; response: NextResponse };

/**
 * Raw body → HMAC (Shopify client secret) → JSON. Shared by all GDPR webhook routes.
 */
export async function verifyShopifyJsonWebhook(
  request: NextRequest
): Promise<VerifiedShopifyJsonWebhook> {
  if (!isShopifyWebhookSecretConfigured()) {
    console.error(
      "[shopify/gdpr] Set SHOPIFY_API_SECRET (Partners → API secret key) on this deployment."
    );
    return {
      ok: false,
      response: new NextResponse("Webhook secret not configured", { status: 503 }),
    };
  }

  const rawBuf = Buffer.from(await request.arrayBuffer());
  const { hmac } = readShopifyWebhookHeaders(request.headers);

  if (!verifyShopifyWebhookHmac({ rawBody: rawBuf, hmacHeader: hmac })) {
    return { ok: false, response: new NextResponse("Unauthorized", { status: 401 }) };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBuf.toString("utf8")) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON" }, { status: 400 }),
    };
  }

  const topic = (request.headers.get("x-shopify-topic") || "").trim();
  const shopFromHeader = (request.headers.get("x-shopify-shop-domain") || "").trim();

  return { ok: true, rawBuf, topic, shopFromHeader, payload };
}
