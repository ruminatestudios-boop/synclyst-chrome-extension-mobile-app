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

export function verifyShopifyWebhookHmac(args: {
  rawBody: string;
  hmacHeader: string;
  secret?: string;
}): boolean {
  const secret = (args.secret ?? getShopifyWebhookSecret()).trim();
  if (!secret) return false;
  if (!args.hmacHeader) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(args.rawBody, "utf8")
    .digest("base64");

  try {
    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(args.hmacHeader, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

