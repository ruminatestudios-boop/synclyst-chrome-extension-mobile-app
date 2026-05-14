#!/usr/bin/env node
/**
 * Ensures manifest.json is the LAN/local dev shape (opposite of verify-store-manifest.mjs).
 * Run after: node extension/build-manifest.mjs --dev
 *
 * Usage: node extension/verify-dev-manifest.mjs [path/to/manifest.json]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(process.argv[2] || path.join(__dirname, "manifest.json"));

const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const issues = [];

const allMatches = [...(m.host_permissions || [])];
for (const cs of m.content_scripts || []) {
  for (const x of cs.matches || []) allMatches.push(x);
}
const blob = allMatches.join("\n");

if (!blob.includes("localhost") && !blob.includes("127.0.0.1")) {
  issues.push("Dev manifest should include localhost or 127.0.0.1 (Next snap-pair on :3000–:3002)");
}
if (!blob.includes("http://*/*")) {
  issues.push("Dev manifest should include http://*/* (phone /snap on LAN IP, tier-bridge)");
}

if (issues.length) {
  console.error(`Dev manifest verification FAILED for ${manifestPath}:\n- ${issues.join("\n- ")}`);
  process.exit(1);
}
console.log(`Dev manifest OK: ${manifestPath}`);
