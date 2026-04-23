#!/usr/bin/env node
/**
 * Tier 2: automated packaging + manifest checks; prints manual Chrome QA (see extension/TIER2-CHROME-QA.txt).
 *
 * Usage (repo root):
 *   node scripts/extension-tier2-qa.mjs        # default: prod
 *   node scripts/extension-tier2-qa.mjs prod
 *   node scripts/extension-tier2-qa.mjs dev    # writes dev manifest to extension/ — restore after
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const REQUIRED_FILES = [
  "manifest.json",
  "popup.html",
  "popup.js",
  "background.js",
  "content-script.js",
  "mapper.js",
  "snap-bridge.js",
  "tier-bridge.js",
  "vendor/supabase.js",
  "vendor/qrcode-generator.js",
  "vendor/qrcode-expose.js",
];

function assertProdDist() {
  const outDir = path.join(ROOT, "dist", "synclyst-chrome-extension");
  const manifestPath = path.join(outDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing ${manifestPath} — build extension first`);
  }

  execFileSync("node", ["extension/verify-store-manifest.mjs", manifestPath], {
    cwd: ROOT,
    stdio: "inherit",
  });

  for (const f of REQUIRED_FILES) {
    const p = path.join(outDir, f);
    if (!fs.existsSync(p)) {
      throw new Error(`Missing packaged file: ${f} (expected ${p})`);
    }
  }

  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (m.manifest_version !== 3) {
    throw new Error("Expected manifest_version 3");
  }
  if (!m.background || typeof m.background.service_worker !== "string") {
    throw new Error("Expected background.service_worker (MV3)");
  }
  if (!m.action || !m.action.default_popup) {
    throw new Error("Expected action.default_popup");
  }

  const ver = m.version || "?";
  console.log(`\n✓ Prod dist MV3 sanity OK (version ${ver}, ${REQUIRED_FILES.length} core paths)\n`);
}

function printManualGuide() {
  const guide = path.join(ROOT, "extension", "TIER2-CHROME-QA.txt");
  console.log(fs.readFileSync(guide, "utf8"));
}

function runProd() {
  execFileSync("bash", [path.join(ROOT, "scripts", "build-extension.sh")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, MANIFEST_MODE: "prod" },
  });
  assertProdDist();
  console.log("--- Tier 2 automated (prod): PASSED ---\n");
  printManualGuide();
}

function runDev() {
  execFileSync("node", [path.join(ROOT, "extension", "build-manifest.mjs"), "--dev"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  execFileSync("node", [path.join(ROOT, "extension", "verify-dev-manifest.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  console.log("\n--- Tier 2 automated (dev): PASSED ---");
  console.log("extension/manifest.json is now DEV. Reload the extension in Chrome.");
  console.log("Restore store manifest before commit / store zip:\n  npm run extension:manifest\n");
  printManualGuide();
}

const mode = (process.argv[2] || "prod").toLowerCase();
if (mode === "dev") {
  runDev();
} else if (mode === "prod") {
  runProd();
} else {
  console.error("Usage: node scripts/extension-tier2-qa.mjs [prod|dev]");
  process.exit(1);
}
