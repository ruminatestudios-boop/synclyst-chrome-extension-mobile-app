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

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

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
export function verifyShopifyWebhookHmac(rawBody, hmacHeader) {
  if (!SHOPIFY_API_SECRET || !hmacHeader || !Buffer.isBuffer(rawBody)) return false;
  const calculatedB64 = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(rawBody).digest('base64');
  const received = String(hmacHeader).trim();
  try {
    const a = Buffer.from(calculatedB64, 'base64');
    const b = Buffer.from(received, 'base64');
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
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
