/**
 * Mandatory compliance webhooks — single HTTPS endpoint for App Store apps.
 */
import { Router } from 'express';
import {
  verifyShopifyWebhookHmac,
  getShopifyWebhookSecret,
  redactShopFromDatabase,
  handleCustomerRedact,
  handleCustomerDataRequest,
  normalizeShopifyDomain,
} from '../webhooks/shopifyCompliance.js';

export const shopifyComplianceRouter = Router();

shopifyComplianceRouter.post('/', async (req, res) => {
  if (!getShopifyWebhookSecret()) {
    console.error('[compliance] Set SHOPIFY_API_SECRET on Cloud Run (same API secret key as Partners / Vercel).');
    return res.status(503).send('Webhook secret not configured');
  }

  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: 'Expected raw body' });
  }

  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!verifyShopifyWebhookHmac(rawBody, hmac)) {
    return res.status(401).send('Unauthorized');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const topic = (req.get('X-Shopify-Topic') || '').trim();

  // Acknowledge immediately (Shopify ~5s timeout). DB work must not turn a valid webhook into 500.
  res.status(200).end();

  void (async () => {
    try {
      switch (topic) {
        case 'customers/data_request': {
          await handleCustomerDataRequest(payload);
          break;
        }
        case 'customers/redact': {
          await handleCustomerRedact(payload);
          break;
        }
        case 'shop/redact': {
          const shop = normalizeShopifyDomain(payload?.shop_domain);
          const result = await redactShopFromDatabase(shop);
          if (!result.ok) {
            console.error('[compliance] shop/redact failed', shop, result.error);
          } else {
            console.log('[compliance] shop/redact ok', shop, result.mode);
          }
          break;
        }
        default: {
          console.warn('[compliance] unknown topic', topic);
        }
      }
    } catch (e) {
      console.error('[compliance] handler error', topic, e?.message || e);
    }
  })();
});
