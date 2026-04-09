import crypto from "crypto";

function getShopifyWebhookSecret(): string {
  return (
    process.env.SHOPIFY_WEBHOOK_SECRET?.trim() ||
    process.env.SHOPIFY_API_SECRET?.trim() ||
    ""
  );
}

export type ShopifyWebhookHeaders = {
  hmac: string;
  topic?: string;
  shopDomain?: string;
  webhookId?: string;
};

export function readShopifyWebhookHeaders(headers: Headers): ShopifyWebhookHeaders {
  return {
    hmac: headers.get("x-shopify-hmac-sha256")?.trim() || "",
    topic: headers.get("x-shopify-topic")?.trim() || undefined,
    shopDomain: headers.get("x-shopify-shop-domain")?.trim() || undefined,
    webhookId: headers.get("x-shopify-webhook-id")?.trim() || undefined,
  };
}

/**
 * Matches Shopify’s HTTPS webhook validation:
 * https://shopify.dev/docs/apps/build/webhooks/subscribe/https#step-2-validate-the-origin-of-your-webhook-to-ensure-its-coming-from-shopify
 * Compare decoded HMAC bytes (not UTF-8 bytes of the base64 strings — padding/variants differ).
 */
export function verifyShopifyWebhookHmac(args: {
  rawBody: string | Buffer;
  hmacHeader: string;
  secret?: string;
}): boolean {
  const secret = (args.secret ?? getShopifyWebhookSecret()).trim();
  if (!secret) return false;
  const received = args.hmacHeader.trim();
  if (!received) return false;

  const bodyBuf = Buffer.isBuffer(args.rawBody)
    ? args.rawBody
    : Buffer.from(args.rawBody, "utf8");

  const calculatedB64 = crypto.createHmac("sha256", secret).update(bodyBuf).digest("base64");

  try {
    const a = Buffer.from(calculatedB64, "base64");
    const b = Buffer.from(received, "base64");
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

