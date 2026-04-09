import crypto from "crypto";

function getShopifyWebhookSecret(): string {
  return (
    process.env.SHOPIFY_API_SECRET?.trim() ||
    process.env.SHOPIFY_CLIENT_SECRET?.trim() ||
    process.env.SHOPIFY_WEBHOOK_SECRET?.trim() ||
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

/** Decode Shopify X-Shopify-Hmac-Sha256 (standard or URL-safe base64, optional padding). */
function decodeShopifyHmacHeader(header: string, expectedLength: number): Buffer | null {
  const t = header.trim();
  const variants = [
    t,
    t.replace(/-/g, "+").replace(/_/g, "/"),
  ];
  for (const v of variants) {
    let padded = v;
    const mod = padded.length % 4;
    if (mod) padded += "=".repeat(4 - mod);
    try {
      const buf = Buffer.from(padded, "base64");
      if (buf.length === expectedLength) return buf;
    } catch {
      /* continue */
    }
  }
  return null;
}

/**
 * HMAC-SHA256 of raw body vs X-Shopify-Hmac-Sha256 (raw digest comparison).
 * @see https://shopify.dev/docs/apps/build/webhooks/subscribe/https#step-2-validate-the-origin-of-your-webhook-to-ensure-its-coming-from-shopify
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

  const calculated = crypto.createHmac("sha256", secret).update(bodyBuf).digest();
  const receivedRaw = decodeShopifyHmacHeader(received, calculated.length);
  if (!receivedRaw) return false;
  try {
    return crypto.timingSafeEqual(calculated, receivedRaw);
  } catch {
    return false;
  }
}
