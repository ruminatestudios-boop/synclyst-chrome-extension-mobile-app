/**
 * Proxies POST /api/v1/vision/extract to the SyncLyst backend.
 * Use NEXT_PUBLIC_API_URL for local dev (e.g. http://localhost:8000) so the
 * static flow (reading-product → review) and app flow both hit your local backend.
 */
const BACKEND =
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.AURALINK_BACKEND_URL ||
  process.env.NEXT_PUBLIC_SYNCLYST_BACKEND_URL ||
  process.env.SYNCLYST_BACKEND_URL ||
  "https://auralink-api-299567386855.us-central1.run.app";

export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "POST image_base64 to extract" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ detail: "Method not allowed" });
  }
  const url = `${BACKEND.replace(/\/$/, "")}/api/v1/vision/extract`;
  try {
    const abort = new AbortController();
    const timeoutMs = 120_000;
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
    console.error("[vision/extract proxy]", e);
    const isAbort = e && (e.name === "AbortError" || e.code === "UND_ERR_HEADERS_TIMEOUT");
    res.status(502).json({
      detail: isAbort
        ? "Extraction timed out. Try again (or use a smaller photo)."
        : "Extraction service unavailable. Try again later.",
    });
  }
}
