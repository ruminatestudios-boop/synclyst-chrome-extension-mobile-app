/**
 * Proxies POST /api/v1/vision/reseller-scan to the SyncLyst backend.
 * Same env as extract.js. Reseller flow can run 120s+ (vision + analysis); timeout aligned with flow-2.html client.
 */
const BACKEND =
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.AURALINK_BACKEND_URL ||
  process.env.NEXT_PUBLIC_SYNCLYST_BACKEND_URL ||
  process.env.SYNCLYST_BACKEND_URL ||
  "https://auralink-api-299567386855.us-central1.run.app";

export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowed = ["https://scan.synclyst.app", "https://synclyst.app", "https://app.synclyst.app"];
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-SyncLyst-Anon-Id");
  }
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") {
    return res
      .status(200)
      .json({ ok: true, message: "POST reseller-scan body (image_base64, …) to proxy upstream vision API" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ detail: "Method not allowed" });
  }
  const url = `${BACKEND.replace(/\/$/, "")}/api/v1/vision/reseller-scan`;
  try {
    const abort = new AbortController();
    const timeoutMs = 180_000;
    const timeoutId = setTimeout(() => abort.abort(), timeoutMs);

    const headers = { "Content-Type": "application/json" };
    if (req.headers.authorization) headers["Authorization"] = req.headers.authorization;
    const anon =
      req.headers["x-synclyst-anon-id"] || req.headers["X-SyncLyst-Anon-Id"];
    if (anon) headers["X-SyncLyst-Anon-Id"] = anon;
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(req.body || {}),
      signal: abort.signal,
    });
    clearTimeout(timeoutId);
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    console.error("[vision/reseller-scan proxy]", e);
    const isAbort = e && (e.name === "AbortError" || e.code === "UND_ERR_HEADERS_TIMEOUT");
    res.status(502).json({
      detail: isAbort
        ? "Reseller scan timed out. Try again (or use a smaller photo)."
        : "Vision service unavailable. Try again later.",
    });
  }
}
