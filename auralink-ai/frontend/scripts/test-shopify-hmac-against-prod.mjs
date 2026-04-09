#!/usr/bin/env node
/**
 * Prove your Vercel SHOPIFY_API_SECRET matches what you think.
 * Uses the SAME HMAC rules as the Next.js webhook route.
 *
 * Usage (use the value from Vercel / Partners “API secret key”, NOT Client ID):
 *   export SHOPIFY_API_SECRET='shpss_...'
 *   node scripts/test-shopify-hmac-against-prod.mjs
 *
 * Optional:
 *   SYNCLYST_BASE_URL=https://synclyst.app node scripts/test-shopify-hmac-against-prod.mjs
 */
import crypto from "crypto";

const base =
  process.env.SYNCLYST_BASE_URL?.replace(/\/$/, "") || "https://synclyst.app";
const secret = process.env.SHOPIFY_API_SECRET?.trim() || "";

if (!secret) {
  console.error("Set SHOPIFY_API_SECRET in the environment (same string as Vercel).");
  process.exit(1);
}

const body = JSON.stringify({
  shop_id: 1,
  shop_domain: "example.myshopify.com",
});

const hmac = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");

const url = `${base}/api/shopify/webhooks/gdpr/compliance`;
const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Hmac-Sha256": hmac,
    "X-Shopify-Topic": "shop/redact",
    "X-Shopify-Shop-Domain": "example.myshopify.com",
  },
  body,
});

const text = await res.text();
console.log("URL:", url);
console.log("Status:", res.status, res.statusText);
console.log("Body:", text.slice(0, 200));

if (res.status === 200) {
  console.log("\nOK — this secret produces a valid HMAC on production. Shopify checks should accept HMAC if the same value is in Vercel.");
  process.exit(0);
}

if (res.status === 401) {
  console.error(
    "\nFAIL — production rejected HMAC. Usually:\n" +
      "  • Wrong value (you pasted Client ID / “API key” instead of “API secret key”)\n" +
      "  • Typo / extra space in Vercel (re-paste, redeploy)\n" +
      "  • Secret is for a different app than synclyst (client_id mismatch)\n" +
      "  • Production hasn’t redeployed since you added the env var"
  );
  process.exit(1);
}

if (res.status === 503) {
  console.error("\nFAIL — production says webhook secret not configured. Add SHOPIFY_API_SECRET on Vercel Production and redeploy.");
  process.exit(1);
}

console.error("\nUnexpected status");
process.exit(1);
