const BACKEND =
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.AURALINK_BACKEND_URL ||
  process.env.NEXT_PUBLIC_SYNCLYST_BACKEND_URL ||
  process.env.SYNCLYST_BACKEND_URL ||
  "http://localhost:8000";

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowed = ["https://scan.synclyst.app", "https://synclyst.app", "https://app.synclyst.app"];
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-SyncLyst-Anon-Id");
  }
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ detail: "Method not allowed" });
  }
  const anon = req.headers["x-synclyst-anon-id"] || req.headers["X-SyncLyst-Anon-Id"];
  const url = `${BACKEND.replace(/\/$/, "")}/api/v1/usage/guest`;
  try {
    const headers = {};
    if (anon) headers["X-SyncLyst-Anon-Id"] = anon;
    const r = await fetch(url, { method: "GET", headers });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    console.error("[usage/guest proxy]", e);
    res.status(502).json({ detail: "Usage service unavailable." });
  }
}
