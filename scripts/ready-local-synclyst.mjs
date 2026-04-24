#!/usr/bin/env node
/**
 * Verifies dev extension manifest + env file exist. Run after: npm run extension:manifest:dev
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const manifestPath = path.join(root, "extension", "manifest.json");
const envLocal = path.join(root, "auralink-ai", "frontend", ".env.local");

let ok = true;
const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const perms = (m.host_permissions || []).join("\n");
if (!perms.includes("127.0.0.1:3000")) {
  console.error("extension/manifest.json is not the DEV manifest (missing 127.0.0.1:3000). Run: npm run extension:manifest:dev");
  ok = false;
} else {
  console.log("OK: dev manifest (localhost snap + popup fetch allowed).");
}

if (!fs.existsSync(envLocal)) {
  console.warn("WARN: auralink-ai/frontend/.env.local is missing. Copy auralink-ai/frontend/.env.local.example → .env.local and set at least Supabase + API URLs.");
  ok = false;
} else {
  console.log("OK: auralink-ai/frontend/.env.local exists.");
  const raw = fs.readFileSync(envLocal, "utf8");
  const hasUrl = /^(?:NEXT_PUBLIC_SUPABASE_URL|SUPABASE_URL)\s*=\s*https?:\/\/\S+/m.test(raw);
  const hasAnon =
    /^(?:NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_ANON_KEY|SUPABASE_PUBLISHABLE_KEY)\s*=\s*\S+/m.test(raw);
  const hasService =
    /^(?:SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY)\s*=\s*\S+/m.test(raw);
  if (!hasUrl || !hasAnon) {
    console.warn("WARN: .env.local should set project URL + publishable anon key (see names in lib/supabase-env.ts). /api/snap-pair/config may show configured:false.");
  } else {
    console.log("OK: .env.local appears to list Supabase URL + anon/publishable key.");
  }
  if (!hasService) {
    console.warn("WARN: no service role key in .env.local — server routes may 503; dev memory may still help in development only.");
  }
  if (!/NEXT_PUBLIC_API_URL\s*=\s*\S+/m.test(raw)) {
    console.warn("WARN: NEXT_PUBLIC_API_URL not set — use http://localhost:8000 if you run npm run dev:synclyst.");
  }
}

console.log(`
--- Local E2E (next steps) ---
1) From repo root start the stack (backend :8000 + Next :3000):
     npm run dev:synclyst
   Or Next only (pairing UI; vision push may need backend):
     cd auralink-ai/frontend && npm run dev

2) Chrome → chrome://extensions → Load unpacked → select this folder:
     ${path.join(root, "extension")}
   Click Reload after any manifest change.

3) Sanity:
     http://127.0.0.1:3000/api/snap-pair/config  → "configured": true
     http://127.0.0.1:3000/snap

4) Extension: open the popup; keep a tab on http://127.0.0.1:3000/snap so origin pins to local.
   Phone (same Wi‑Fi): http://<your-LAN-IP>:3000/snap?s=SESSION

5) Before Chrome Web Store zip (restore prod manifest):
     npm run extension:manifest && npm run extension:package
`);
process.exit(ok ? 0 : 1);
