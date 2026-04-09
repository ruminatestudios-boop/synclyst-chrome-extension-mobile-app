#!/usr/bin/env node
/**
 * Step-2 style check: POST each mandatory GDPR webhook path without HMAC.
 * Expect HTTP 401 + JSON { error: "Invalid HMAC" } when routes + verification are live.
 * Expect 404 if the deployment is missing the App Router handlers.
 *
 * Usage:
 *   SYNCLYST_BASE_URL=https://synclyst.app node scripts/verify-shopify-gdpr-webhooks.mjs
 *   npm run verify:shopify-webhooks
 */
const base =
  process.env.SYNCLYST_BASE_URL?.replace(/\/$/, "") || "https://synclyst.app";

const paths = [
  "/api/shopify/webhooks/gdpr/customers-data-request",
  "/api/shopify/webhooks/gdpr/customers-redact",
  "/api/shopify/webhooks/gdpr/shop-redact",
];

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
    const ok = res.status === 401 && bodySnippet.includes("Invalid HMAC");
    if (!ok) {
      failed = true;
      console.error(`FAIL ${res.status} ${url}`);
      console.error(`       body: ${bodySnippet}`);
    } else {
      console.log(`OK   401 ${url}`);
    }
  }
  if (failed) {
    console.error(
      "\nExpected 401 with Invalid HMAC for each path (unsigned POST).",
      "\nIf you see 404, deploy the GDPR webhook routes to this host (Synclyst main + Vercel)."
    );
    process.exit(1);
  }
  console.log("\nAll GDPR webhook routes respond with HMAC verification (Shopify checks should pass once URLs + secret match).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
