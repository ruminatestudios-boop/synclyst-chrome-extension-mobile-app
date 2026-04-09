import crypto from "crypto";

/**
 * Prefer API secret key (Partners). Avoid naming an env `SHOPIFY_WEBHOOK_SECRET` with a
 * stale value — it overrides nothing here (API secret wins) but can confuse operators.
 */
function getShopifyWebhookSecret(): string {
  return (
    process.env.SHOPIFY_API_SECRET?.trim() ||
    process.env.SHOPIFY_CLIENT_SECRET?.trim() ||
    process.env.SHOPIFY_WEBHOOK_SECRET?.trim() ||
    ""
  );
}

/** True when Vercel/Node has a secret to verify Shopify HMAC (for clear 503 vs 401). */
export function isShopifyWebhookSecretConfigured(): boolean {
  return getShopifyWebhookSecret().length > 0;
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

/** Shopify Node docs: compare `digest('base64')` decoded to header decoded (standard base64). */
function verifyHmacShopifyDocStyle(secret: string, bodyBuf: Buffer, received: string): boolean {
  let calculatedB64: string;
  try {
    calculatedB64 = crypto.createHmac("sha256", secret).update(bodyBuf).digest("base64");
  } catch {
    return false;
  }
  const a = Buffer.from(calculatedB64, "base64");
  if (a.length !== 32) return false;

  const bases = [received.trim(), received.trim().replace(/-/g, "+").replace(/_/g, "/")];
  for (const base of bases) {
    for (let pad = 0; pad < 4; pad++) {
      const padded = base + (pad ? "=".repeat(pad) : "");
      try {
        const b = Buffer.from(padded, "base64");
        if (b.length === 32 && crypto.timingSafeEqual(a, b)) return true;
      } catch {
        /* invalid base64 */
      }
    }
  }
  return false;
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
  if (receivedRaw) {
    try {
      if (crypto.timingSafeEqual(calculated, receivedRaw)) return true;
    } catch {
      /* fall through */
    }
  }
  return verifyHmacShopifyDocStyle(secret, bodyBuf, received);
}
