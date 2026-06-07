#!/usr/bin/env node
/**
 * Copy public/landing.html → repo root index.html
 *
 * Why: synclyst.app may be deployed from the Git repo root (static hosting).
 * The canonical landing is auralink-ai/frontend/public/landing.html.
 * Run after changing landing.html before push, or wire into CI.
 */
const fs = require("fs");
const path = require("path");

const landing = path.join(__dirname, "../public/landing.html");
const rootIndex = path.join(__dirname, "../../../index.html");

if (!fs.existsSync(landing)) {
  console.error("[sync-root-index] Missing", landing);
  process.exit(1);
}
let html = fs.readFileSync(landing, "utf8");
// Marketing (synclyst.app) is static at repo root; app flows live on app.synclyst.app.
html = html.replace(
  /<meta name="synclyst-app-origin" content="[^"]*"\s*\/>/,
  '<meta name="synclyst-app-origin" content="https://app.synclyst.app" />'
);
fs.writeFileSync(rootIndex, html);
const rootLanding = path.join(__dirname, "../../../landing.html");
fs.writeFileSync(rootLanding, html);
console.log("[sync-root-index] Wrote", rootIndex, "and", rootLanding);
