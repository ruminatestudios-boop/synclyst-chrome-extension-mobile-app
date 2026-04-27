#!/usr/bin/env node
/**
 * Single source of truth for Chrome host/content-script patterns.
 * - prod (default): store-ready — no <all_urls>, no localhost
 * - dev (--dev): localhost for Next snap-pair + popup origin probe
 *
 * Usage: node extension/build-manifest.mjs [--dev]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.argv.includes("--dev");

/** URLs where Magic Fill runs (must stay aligned with host_permissions for programmatic inject). */
const SELLER_HOST_MATCHES = [
  "https://admin.shopify.com/*",
  "https://*.ebay.com/*",
  "https://*.etsy.com/*",
  "https://www.vinted.co.uk/*",
  "https://www.vinted.de/*",
  "https://www.vinted.fr/*",
  "https://www.vinted.com/*",
  "https://seller.shopee.sg/*",
  "https://seller.shopee.co.id/*",
  "https://seller.shopee.co.th/*",
  "https://seller.shopee.com.my/*",
  "https://seller.shopee.ph/*",
  "https://seller.shopee.tw/*",
  "https://seller.shopee.vn/*",
  "https://seller.shopee.com.br/*",
  "https://banhang.shopee.vn/*",
  "https://sellercenter.lazada.co.id/*",
  "https://sellercenter.lazada.sg/*",
  "https://sellercenter.lazada.co.th/*",
  "https://sellercenter.lazada.com.my/*",
  "https://sellercenter.lazada.com.ph/*",
  "https://sellercenter.lazada.vn/*",
  "https://sellercentral.amazon.com/*",
  "https://sellercentral.amazon.co.uk/*",
  "https://sellercentral.amazon.de/*",
  "https://sellercentral.amazon.fr/*",
  "https://sellercentral.amazon.it/*",
  "https://sellercentral.amazon.es/*",
  "https://sellercentral.amazon.ca/*",
  "https://sellercentral.amazon.com.au/*",
  "https://sellercentral.amazon.in/*",
  "https://sellercentral.amazon.co.jp/*",
  "https://sellercentral.amazon.com.mx/*",
  "https://*.depop.com/*",
  "https://seller.tiktok.com/*",
  "https://seller-us.tiktok.com/*",
  "https://seller-uk.tiktok.com/*",
  "https://seller-id.tiktok.com/*",
  "https://seller-my.tiktok.com/*",
  "https://seller-th.tiktok.com/*",
  "https://seller-vn.tiktok.com/*",
  "https://seller-ph.tiktok.com/*",
  "https://seller-sg.tiktok.com/*",
  "https://business.facebook.com/*",
  "https://www.facebook.com/*",
  "https://www.instagram.com/*",
];

const host_permissions = [
  ...SELLER_HOST_MATCHES,
  "https://synclyst.app/*",
  /** Vercel preview / staging (e.g. synclystchrome.vercel.app) — snap + snap-pair API for popup. */
  "https://*.vercel.app/*",
  "https://*.supabase.co/*",
];
if (isDev) {
  // Next dev server may auto-bump ports if 3000 is busy (see auralink-ai/frontend/scripts/dev-open.js)
  host_permissions.push(
    "http://localhost:3000/*",
    "http://127.0.0.1:3000/*",
    "http://localhost:3001/*",
    "http://127.0.0.1:3001/*",
    "http://localhost:3002/*",
    "http://127.0.0.1:3002/*",
    // LAN IPs for snap-pair probe + phone-opened http://192.168.x.x:3000/snap
    "http://*/*"
  );
}

const snapBridgeMatches = isDev
  ? [
      "https://synclyst.app/snap*",
      "https://synclyst.app/extension-review*",
      "https://*.vercel.app/snap*",
      "https://*.vercel.app/extension-review*",
      "http://*/*",
    ]
  : [
      "https://synclyst.app/snap*",
      "https://synclyst.app/extension-review*",
      "https://*.vercel.app/snap*",
      "https://*.vercel.app/extension-review*",
    ];

/** localStorage → chrome.storage for plan label in popup (payment-success.html). */
const tierBridgeMatches = isDev
  ? [
      "https://synclyst.app/*",
      "http://localhost:3000/*",
      "http://127.0.0.1:3000/*",
      "http://localhost:3001/*",
      "http://127.0.0.1:3001/*",
      "http://localhost:3002/*",
      "http://127.0.0.1:3002/*",
    ]
  : ["https://synclyst.app/*"];

const extensionPagesCsp = isDev
  ? "script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.supabase.co; connect-src 'self' http: https: ws: wss: https://synclyst.app http://localhost:3000 http://127.0.0.1:3000 http://localhost:3001 http://127.0.0.1:3001 http://localhost:3002 http://127.0.0.1:3002 https://*.supabase.co wss://*.supabase.co"
  : "script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.supabase.co; connect-src 'self' https://synclyst.app https://*.vercel.app https://*.supabase.co wss://*.supabase.co";

/** Toolbar + chrome://extensions — paths relative to extension root. */
const extensionIcons = {
  "16": "icons/synclyst-16.png",
  "32": "icons/synclyst-32.png",
  "48": "icons/synclyst-48.png",
  "128": "icons/synclyst-128.png",
  "512": "icons/synclyst-512.png",
};

const manifest = {
  manifest_version: 3,
  name: "SyncLyst®",
  version: "2.0.76",
  description: "Pair your phone to scan products and auto-fill listings on Shopify, eBay, Etsy, Amazon, TikTok Shop, and more.",
  icons: extensionIcons,
  permissions: ["storage", "activeTab", "scripting", "tabs"],
  host_permissions,
  action: {
    default_title: "SyncLyst®",
    default_popup: "popup.html",
    default_icon: {
      "16": "icons/synclyst-16.png",
      "32": "icons/synclyst-32.png",
      "48": "icons/synclyst-48.png",
    },
  },
  background: {
    service_worker: "background.js",
  },
  content_security_policy: {
    extension_pages: extensionPagesCsp,
  },
  content_scripts: [
    {
      matches: SELLER_HOST_MATCHES,
      js: ["mapper.js", "content-script.js"],
      run_at: "document_idle",
    },
    {
      matches: snapBridgeMatches,
      js: ["snap-bridge.js"],
      run_at: "document_idle",
    },
    {
      matches: tierBridgeMatches,
      js: ["tier-bridge.js"],
      run_at: "document_idle",
    },
  ],
};

const outPath = path.join(__dirname, "manifest.json");
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote ${outPath} (${isDev ? "dev" : "prod"})`);
