/**
 * SyncLyst Publishing API — Express app
 * OAuth, token refresh, universal → platform translation, publish orchestration.
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth.js';
import { publishRouter } from './routes/publish.js';
import { storesRouter } from './routes/stores.js';
import { exportRouter } from './routes/export.js';
import { shopifyComplianceRouter } from './routes/shopifyComplianceWebhooks.js';

const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const allowedOrigins = FRONTEND_URL.includes(',')
  ? FRONTEND_URL.split(',').map((u) => u.trim()).filter(Boolean)
  : [FRONTEND_URL];
// In dev, allow common local origins (different ports/hostnames)
if (process.env.NODE_ENV !== 'production') {
  ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:8080', 'http://127.0.0.1:8080'].forEach(function(o) {
    if (allowedOrigins.indexOf(o) === -1) allowedOrigins.push(o);
  });
}
// Ensure production frontend is allowed when running on Cloud Run (in case FRONTEND_URL is unset)
const isCloudRun = /\.run\.app$/i.test(process.env.APP_URL || '');
if (isCloudRun) {
  const prod = ['https://synclyst.app', 'https://www.synclyst.app'];
  prod.forEach((o) => { if (!allowedOrigins.includes(o)) allowedOrigins.push(o); });
}
const allowAllOrigins = process.env.NODE_ENV !== 'production';

function corsHeaders(req, res, next) {
  const origin = req.headers.origin;
  const isSynclystProd = origin === 'https://synclyst.app' || origin === 'https://www.synclyst.app';
  const isLocalDev = process.env.NODE_ENV !== 'production' && origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  const allowOrigin = origin && (isSynclystProd || allowAllOrigins || allowedOrigins.includes(origin) || isLocalDev) ? origin : null;
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Id');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
}
app.use(corsHeaders);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin === 'https://synclyst.app' || origin === 'https://www.synclyst.app') return cb(null, origin);
    if (allowedOrigins[0] === true) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, origin);
    // In dev, allow any localhost / 127.0.0.1 (any port) to avoid "fetch failed" from CORS
    if (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return cb(null, origin);
    cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id'],
}));
// Shopify mandatory GDPR webhooks: HMAC is computed over the raw body — must not use express.json() first.
// Use type '*/*' so probes still get a parsed body if Content-Type varies (strict JSON-only match → empty body → 400).
app.use(
  '/webhooks/shopify/compliance',
  express.raw({
    type: '*/*',
    limit: '256kb',
  }),
  shopifyComplianceRouter
);
// Large universal_data payloads (base64 photos) exceed express.json default (~100kb). Cloud Run max request ~32 MiB.
// If JSON_BODY_LIMIT is set in Cloud Run, keep it ≤ 31mb or you will still get PayloadTooLargeError from raw-body.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '31mb' }));

app.get('/auth/shopify/status', (req, res) => {
  const configured = !!(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET);
  const publicInstallDisabled = /^(1|true|yes)$/i.test(
    (process.env.SHOPIFY_PUBLIC_INSTALL_DISABLED || '').trim()
  );
  const publicInstallEnabled =
    !publicInstallDisabled &&
    !/^(0|false|no)$/i.test((process.env.SHOPIFY_PUBLIC_INSTALL_ENABLED || 'true').trim());
  const appUrl = (process.env.APP_URL || 'http://localhost:8001').replace(/\/$/, '');
  const redirectUriOverride = (process.env.SHOPIFY_REDIRECT_URI || '').trim();
  const redirectUri = redirectUriOverride || `${appUrl}/auth/shopify/callback`;
  const localRedirectUri = 'http://localhost:8001/auth/shopify/callback';
  const extraRedirectUris = (process.env.SHOPIFY_ADDITIONAL_REDIRECT_URIS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const recommendedRedirectUris = Array.from(new Set([redirectUri, localRedirectUri, ...extraRedirectUris]));
  const devTok = (process.env.SHOPIFY_DEV_ACCESS_TOKEN || '').trim();
  const devShop = (process.env.SHOPIFY_DEV_SHOP_DOMAIN || '').trim();
  const devBypass = !!(devTok && devShop);
  const bypassDisabled = /^(1|true|yes)$/i.test(process.env.DISABLE_DEV_SHOPIFY_CONNECT_BYPASS || '');
  const dev_shopify_bypass = devBypass && !bypassDisabled;
  const dev_shop_domain = dev_shopify_bypass
    ? devShop.replace(/\.myshopify\.com$/i, '') + '.myshopify.com'
    : null;
  res.json({
    shopify_configured: configured,
    public_install_enabled: publicInstallEnabled,
    redirect_uri: redirectUri,
    recommended_redirect_uris: recommendedRedirectUris,
    dev_shopify_bypass,
    dev_shop_domain,
  });
});
app.use('/auth', authRouter);
app.use('/api/listings', publishRouter);
app.use('/api/user', storesRouter);
app.use('/api/listings', exportRouter);

app.get('/', (req, res) => {
  res.json({
    service: 'synclyst-publishing-api',
    message: 'Publishing API is running. Use these endpoints:',
    endpoints: {
      health: 'GET /health',
      enabledPlatforms: 'GET /api/listings/enabled-platforms',
      platformFields: 'GET /api/listings/platform-fields',
      listListings: 'GET /api/listings (JWT)',
      createListing: 'POST /api/listings (body: universal_data)',
      publish: 'POST /api/listings/publish',
      connectedStores: 'GET /api/user/connected-stores',
      shopifyAuth: 'GET /auth/shopify?shop=your-store.myshopify.com',
      shopifyComplianceWebhooks: 'POST /webhooks/shopify/compliance (mandatory for App Store)',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'synclyst-publishing-api' });
});

const PORT = process.env.PORT || 8001;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Publishing API listening on http://${HOST}:${PORT}`);
});

export default app;
