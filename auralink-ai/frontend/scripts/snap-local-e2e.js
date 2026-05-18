#!/usr/bin/env node
/**
 * Prints how to run Snap-to-List (phone ↔ extension) against local Next + backend.
 * Does not start servers — use as a checklist.
 */
const fs = require("fs");
const path = require("path");

const envLocal = path.join(__dirname, "..", ".env.local");
let hasSupabase = false;
try {
  const raw = fs.readFileSync(envLocal, "utf8");
  hasSupabase =
    /NEXT_PUBLIC_SUPABASE_URL\s*=\s*https?:\/\//.test(raw) &&
    /SUPABASE_SERVICE_ROLE_KEY\s*=/.test(raw);
} catch {
  /* no .env.local */
}

const frontendDir = path.join(__dirname, "..");
const backend = path.join(frontendDir, "..", "backend");

console.log("");
console.log("SyncLyst — Snap-to-List local end-to-end");
console.log("=========================================");
console.log("");
console.log("1) Env (frontend/.env.local)");
console.log("   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (table snap_pair_sessions, Realtime on)");
console.log("   - NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 (or your LAN IP :8000 if testing phone on Wi‑Fi)");
console.log(
  hasSupabase
    ? "   ✓ Looks like Supabase vars may be present in .env.local"
    : "   ⚠ No Supabase in .env.local — snap-pair uses in-memory store in dev (OK for local E2E)"
);
console.log("");
console.log("2) Terminal A — vision backend (from repo root or backend folder):");
console.log("   cd " + backend);
console.log("   # activate venv, then:");
console.log("   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000");
console.log("");
console.log("3) Terminal B — Next.js:");
console.log("   cd " + frontendDir);
console.log("   npm run dev");
console.log("   # Phone on same Wi‑Fi: npm run dev:phone  (sets API URL to your LAN IP)");
console.log("");
console.log("4) Point the extension at local Next (one-time per profile):");
console.log("   - Open the SyncLyst extension popup → right‑click → Inspect");
console.log("   - In the Console tab run:");
console.log('     chrome.storage.local.set({ synclyst_origin: "http://localhost:3000" });');
console.log("   - Testing from a phone on Wi‑Fi: use your Mac’s LAN URL instead, e.g.");
console.log('     chrome.storage.local.set({ synclyst_origin: "http://192.168.1.x:3000" });');
console.log("   - Reload the extension (chrome://extensions → Reload)");
console.log("   - To use production again:");
console.log("     chrome.storage.local.remove([\"synclyst_origin\"]);");
console.log("");
console.log("5) Flow");
console.log("   - Open the popup: QR / pair URL should show http://localhost:3000/snap?s=…");
console.log("   - Open that URL (or scan QR) on phone / second tab; upload a product photo");
console.log("   - Popup should show listing (Realtime or polling); Magic Fill on a listing tab");
console.log("");
