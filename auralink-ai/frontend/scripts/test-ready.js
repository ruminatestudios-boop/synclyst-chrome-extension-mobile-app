#!/usr/bin/env node
/**
 * Checks backend + Next dev servers and opens the local test helper page.
 * Usage: npm run test:ready
 */
const http = require("http");
const path = require("path");

function check(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname || "/",
        method: "GET",
        timeout: 4000,
      },
      (res) => {
        resolve(res.statusCode || 0);
      }
    );
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });
}

(async () => {
  const backend = await check("http://127.0.0.1:8000/docs");
  const next = await check("http://127.0.0.1:3000/");

  const frontendDir = path.join(__dirname, "..");
  const backendDir = path.join(frontendDir, "..", "backend");

  console.log("");
  console.log("SyncLyst — local test readiness");
  console.log("================================");
  console.log("");
  console.log("Backend  http://127.0.0.1:8000/docs   ", backend === 200 ? "OK" : "NOT RUNNING");
  console.log("Next.js  http://127.0.0.1:3000/       ", next === 200 ? "OK" : "NOT RUNNING");
  console.log("");

  if (backend !== 200) {
    console.log("Start backend:");
    console.log("  cd " + backendDir);
    console.log("  python3 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000");
    console.log("");
  }
  if (next !== 200) {
    console.log("Start frontend:");
    console.log("  cd " + frontendDir);
    console.log("  npm run dev:no-open");
    console.log("");
  }

  const testUrl = "http://127.0.0.1:3000/local-test";
  if (next === 200) {
    console.log("Extension + Snap pairing test page (open this in Chrome):");
    console.log("  " + testUrl);
    console.log("");
    console.log("Phone on same Wi‑Fi: http://<your-LAN-IP>:3000/local-test");
    console.log("  (The extension popup QR should use your LAN IP automatically when possible.)");
    console.log("");
  }
  if (next === 200 && backend !== 200) {
    console.log("Backend not required for pairing QR / Magic Fill smoke test — only Next.js above.");
    console.log("");
  }

  if (next === 200) {
    try {
      const open = (await import("open")).default;
      await open(testUrl);
      console.log("Opened local-test in your browser.");
    } catch {
      console.log("Could not auto-open browser — visit the URL above.");
    }
  }

  console.log("");
})();
