/**
 * Catch-all proxy for /api/v1/products/* → FastAPI backend.
 * Covers:
 *   POST /api/v1/products/from-extraction
 *   POST /api/v1/products/:id/push-drafts
 *   GET  /api/v1/products/:id
 *   GET  /api/v1/products/mcp-latest
 */
const BACKEND =
  process.env.AURALINK_BACKEND_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://auralink-api-299567386855.us-central1.run.app";

export const config = { api: { bodyParser: { sizeLimit: "5mb" } } };

export default async function handler(req, res) {
  const { path = [] } = req.query;
  const subpath = Array.isArray(path) ? path.join("/") : path;
  const url = `${BACKEND.replace(/\/$/, "")}/api/v1/products${subpath ? `/${subpath}` : ""}`;

  try {
    const headers = { "Content-Type": "application/json" };
    if (req.headers.authorization) headers["Authorization"] = req.headers.authorization;

    const hasBody = ["POST", "PUT", "PATCH"].includes(req.method);
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
      signal: AbortSignal.timeout(30000),
    });

    const body = await upstream.text();
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!["content-encoding", "transfer-encoding", "connection"].includes(k)) res.setHeader(k, v);
    });
    res.end(body);
  } catch (e) {
    res.status(502).json({ detail: `Proxy error: ${e.message}` });
  }
}
