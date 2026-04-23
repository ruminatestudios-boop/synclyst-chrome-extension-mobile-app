#!/usr/bin/env node
/**
 * Fails if manifest.json looks like a dev / LAN build (store reviewers flag these).
 * Run after: node extension/build-manifest.mjs
 *
 * Usage: node extension/verify-store-manifest.mjs [path/to/manifest.json]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(process.argv[2] || path.join(__dirname, "manifest.json"));

const raw = fs.readFileSync(manifestPath, "utf8");
const m = JSON.parse(raw);
const issues = [];

function noteHost(h, ctx) {
  if (!h || typeof h !== "string") return;
  if (h.includes("http://*/*")) issues.push(`${ctx}: forbidden pattern http://*/*`);
  if (h.includes("localhost") || h.includes("127.0.0.1")) issues.push(`${ctx}: localhost / 127.0.0.1 not allowed in store manifest (${h})`);
  if (h === "<all_urls>" || h === "*://*/*") issues.push(`${ctx}: overly broad match (${h})`);
}

for (const h of m.host_permissions || []) noteHost(h, "host_permissions");
for (const cs of m.content_scripts || []) {
  const label = `content_scripts[${(cs.js || []).join(",")}]`;
  for (const pat of cs.matches || []) noteHost(pat, label);
}

const csp = m.content_security_policy?.extension_pages || "";
if (/\bhttp:\b/.test(csp)) issues.push("extension_pages CSP: bare http: scheme (use dev manifest for local/LAN)");
if (/\bhttps:\b/.test(csp)) issues.push("extension_pages CSP: bare https: scheme (list explicit hosts only)");
if (/\bws:\b/.test(csp) || /\bwss:\b/.test(csp)) issues.push("extension_pages CSP: bare ws:/wss: scheme (list explicit hosts only)");
if (csp.includes("localhost") || csp.includes("127.0.0.1")) {
  issues.push("extension_pages CSP references localhost / 127.0.0.1");
}

if (issues.length) {
  console.error(`Store manifest verification FAILED for ${manifestPath}:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}
console.log(`Store manifest OK: ${manifestPath}`);
