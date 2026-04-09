#!/usr/bin/env node
/**
 * One-shot health check for Shopify GDPR + HMAC (Vercel + optional Cloud Run).
 *
 * Usage:
 *   cd auralink-ai/frontend && npm run verify:shopify:full
 *   SHOPIFY_API_SECRET=shpss_... npm run verify:shopify:full
 *
 * Env:
 *   SYNCLYST_BASE_URL   (default https://synclyst.app)
 *   CLOUD_RUN_COMPLIANCE_URL (default: publishing service from shopify.app.toml)
 */
import crypto from "crypto";

const base =
  process.env.SYNCLYST_BASE_URL?.replace(/\/$/, "") || "https://synclyst.app";
const cloudCompliance =
  process.env.CLOUD_RUN_COMPLIANCE_URL?.replace(/\/$/, "") ||
  "https://synclyst-publishing-299567386855.us-central1.run.app/webhooks/shopify/compliance";

const vercelPaths = [
  "/api/shopify/webhooks/gdpr/compliance",
  "/api/shopify/webhooks/gdpr/customers-data-request",
  "/api/shopify/webhooks/gdpr/customers-redact",
  "/api/shopify/webhooks/gdpr/shop-redact",
];

function expectUnsigned(status, text) {
  const t = text.trim();
  return (
    (status === 401 && t === "Unauthorized") ||
    (status === 503 && t.includes("Webhook secret not configured"))
  );
}

async function readRes(res) {
  const text = await res.text();
  return { status: res.status, text };
}

async function probeUnsigned(url, label) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const { status, text } = await readRes(res);
  const pass = expectUnsigned(status, text);
  if (pass) {
    console.log(`OK   ${status} unsigned ${label}`);
    return true;
  }
  console.error(`FAIL ${status} ${label}\n     ${text.slice(0, 160)}`);
  return false;
}

async function probeSigned(url, label) {
  const secret = process.env.SHOPIFY_API_SECRET?.trim();
  if (!secret) return true;
  const body = JSON.stringify({
    shop_id: 1,
    shop_domain: "example.myshopify.com",
  });
  const hmac = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
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
  const { status, text } = await readRes(res);
  if (status === 200) {
    console.log(`OK   200 signed ${label}`);
    return true;
  }
  console.error(`FAIL ${status} signed ${label}\n     ${text.slice(0, 200)}`);
  return false;
}

async function main() {
  let ok = true;
  console.log("— Unsigned POST (expect 401 Unauthorized or 503 if secret missing) —\n");

  for (const p of vercelPaths) {
    if (!(await probeUnsigned(`${base}${p}`, `${base}${p}`))) ok = false;
  }

  if (!(await probeUnsigned(cloudCompliance, cloudCompliance))) {
    ok = false;
  }

  console.log("\n— Signed POST (needs SHOPIFY_API_SECRET = Partners API secret key) —\n");

  if (process.env.SHOPIFY_API_SECRET?.trim()) {
    if (!(await probeSigned(`${base}/api/shopify/webhooks/gdpr/compliance`, "Vercel compliance"))) {
      ok = false;
    }
    if (!(await probeSigned(cloudCompliance, "Cloud Run compliance"))) {
      ok = false;
    }
  } else {
    console.log("SKIP signed (export SHOPIFY_API_SECRET to validate HMAC matches production)");
  }

  if (!ok) {
    console.error(
      "\nFix: Vercel Production → SHOPIFY_API_SECRET (API secret key, not Client ID). Redeploy.\n" +
        "Cloud Run publishing → same secret. Partners compliance URLs → https://synclyst.app/api/shopify/webhooks/gdpr/compliance\n" +
        "Then: cd auralink-ai/publishing && npm run shopify:deploy-config\n"
    );
    process.exit(1);
  }

  console.log("\nAll probes passed within scope.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
