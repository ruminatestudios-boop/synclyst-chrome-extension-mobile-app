/**
 * Shopify mandatory compliance webhooks (App Store / public apps).
 * @see https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 *
 * Subscribe in Partners → App setup → Compliance webhooks, same URL for all three topics:
 *   POST {APP_URL}/webhooks/shopify/compliance
 * Verify with X-Shopify-Hmac-Sha256 + API secret; invalid HMAC → 401.
 */
import crypto from 'crypto';
import { getSupabase } from '../db/client.js';
import { isDevMode, devDeleteShopifyTokensForShopDomain } from '../db/devStore.js';

export function getShopifyWebhookSecret() {
  return (
    (process.env.SHOPIFY_API_SECRET || '').trim() ||
    (process.env.SHOPIFY_CLIENT_SECRET || '').trim() ||
    (process.env.SHOPIFY_WEBHOOK_SECRET || '').trim()
  );
}

export function normalizeShopifyDomain(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  const sub = raw.replace(/\.myshopify\.com$/i, '').replace(/[^a-z0-9-]/g, '');
  if (!sub || sub.length > 60) return '';
  return `${sub}.myshopify.com`;
}

/**
 * @param {Buffer} rawBody
 * @param {string|undefined} hmacHeader X-Shopify-Hmac-Sha256
 */
function decodeShopifyHmacHeader(header, expectedLength) {
  const t = String(header || '').trim();
  const variants = [t, t.replace(/-/g, '+').replace(/_/g, '/')];
  for (const v of variants) {
    let padded = v;
    const mod = padded.length % 4;
    if (mod) padded += '='.repeat(4 - mod);
    try {
      const buf = Buffer.from(padded, 'base64');
      if (buf.length === expectedLength) return buf;
    } catch {
      /* continue */
    }
  }
  return null;
}

function verifyHmacShopifyDocStyle(secret, bodyBuf, received) {
  let calculatedB64;
  try {
    calculatedB64 = crypto.createHmac('sha256', secret).update(bodyBuf).digest('base64');
  } catch {
    return false;
  }
  const a = Buffer.from(calculatedB64, 'base64');
  if (a.length !== 32) return false;
  const bases = [String(received).trim(), String(received).trim().replace(/-/g, '+').replace(/_/g, '/')];
  for (const base of bases) {
    for (let pad = 0; pad < 4; pad++) {
      const padded = base + (pad ? '='.repeat(pad) : '');
      try {
        const b = Buffer.from(padded, 'base64');
        if (b.length === 32 && crypto.timingSafeEqual(a, b)) return true;
      } catch {
        /* invalid base64 */
      }
    }
  }
  return false;
}

export function verifyShopifyWebhookHmac(rawBody, hmacHeader) {
  const secret = getShopifyWebhookSecret();
  if (!secret || !hmacHeader || !Buffer.isBuffer(rawBody)) return false;
  const calculated = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const receivedRaw = decodeShopifyHmacHeader(hmacHeader, calculated.length);
  if (receivedRaw) {
    try {
      if (crypto.timingSafeEqual(calculated, receivedRaw)) return true;
    } catch {
      /* fall through */
    }
  }
  return verifyHmacShopifyDocStyle(secret, rawBody, hmacHeader);
}

/**
 * Removes OAuth rows for the uninstalled / redacted shop so tokens are not retained.
 */
export async function redactShopFromDatabase(shopDomain) {
  const domain = normalizeShopifyDomain(shopDomain);
  if (!domain) return { ok: false, error: 'invalid_shop_domain' };

  if (isDevMode()) {
    devDeleteShopifyTokensForShopDomain(domain);
    return { ok: true, mode: 'dev_memory' };
  }

  const db = getSupabase();
  if (!db) {
    devDeleteShopifyTokensForShopDomain(domain);
    return { ok: true, mode: 'fallback_memory' };
  }

  const { error } = await db.from('platform_tokens').delete().eq('platform', 'shopify').eq('shop_domain', domain);
  if (error) {
    console.error('[compliance] shop/redact DB delete failed', domain, error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, mode: 'supabase' };
}

/**
 * SyncLyst does not persist Shopify customer IDs or order PII in the publishing DB schema.
 * If you add tables that store customer data, delete those rows here keyed by payload.customer.id / orders.
 */
export async function handleCustomerRedact(_payload) {
  return { ok: true, note: 'no_customer_pii_in_publishing_schema' };
}

/**
 * For GDPR data request: merchant may need any customer-related data you stored.
 * Return 200 after logging internally if you need manual export.
 */
export async function handleCustomerDataRequest(payload) {
  const customerId = payload?.customer?.id;
  const shop = normalizeShopifyDomain(payload?.shop_domain);
  console.log('[compliance] customers/data_request shop=%s customer_id=%s', shop || '?', customerId ?? '?');
  return { ok: true };
}
