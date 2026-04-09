#!/usr/bin/env node
/**
 * POST each GDPR path without HMAC. Expect 401 + body "Unauthorized" (Shopify-style).
 *
 * Usage:
 *   SYNCLYST_BASE_URL=https://synclyst.app node scripts/verify-shopify-gdpr-webhooks.mjs
 *   npm run verify:shopify-webhooks
 */
const base =
  process.env.SYNCLYST_BASE_URL?.replace(/\/$/, "") || "https://synclyst.app";

const paths = [
  "/api/shopify/webhooks/gdpr/compliance",
  "/api/shopify/webhooks/gdpr/customers-data-request",
  "/api/shopify/webhooks/gdpr/customers-redact",
  "/api/shopify/webhooks/gdpr/shop-redact",
];

function isUnauthorized401(status, bodySnippet) {
  if (status !== 401) return false;
  const s = bodySnippet.trim();
  return s === "Unauthorized" || s.includes("Invalid HMAC");
}

function isMisconfigured503(status, bodySnippet) {
  return (
    status === 503 && bodySnippet.includes("Webhook secret not configured")
  );
}

async function main() {
  let failed = false;
  for (const p of paths) {
    const url = `${base}${p}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    let bodySnippet = "";
    try {
      const t = await res.text();
      bodySnippet = t.slice(0, 120);
    } catch {
      bodySnippet = "(no body)";
    }
    if (isMisconfigured503(res.status, bodySnippet)) {
      failed = true;
      console.error(`FAIL ${res.status} ${url} — add SHOPIFY_API_SECRET on Vercel Production + redeploy`);
      console.error(`       body: ${bodySnippet}`);
    } else if (!isUnauthorized401(res.status, bodySnippet)) {
      failed = true;
      console.error(`FAIL ${res.status} ${url}`);
      console.error(`       body: ${bodySnippet}`);
    } else {
      console.log(`OK   401 ${url}`);
    }
  }
  if (failed) {
    console.error(
      "\nExpected 401 Unauthorized for unsigned POST (HMAC required).",
      "\n404 = route not deployed (merge + Vercel deploy)."
    );
    process.exit(1);
  }
  console.log(
    "\nAll GDPR paths enforce HMAC. Register mandatory topics at /api/shopify/webhooks/gdpr/compliance (shopify.app.toml) + SHOPIFY_API_SECRET on Vercel."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
