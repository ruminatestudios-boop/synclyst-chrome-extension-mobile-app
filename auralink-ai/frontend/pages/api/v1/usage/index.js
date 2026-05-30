/** Proxy GET /api/v1/usage → FastAPI backend. */
const BACKEND =
  process.env.AURALINK_BACKEND_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://auralink-api-299567386855.us-central1.run.app";

export default async function handler(req, res) {
  const url = `${BACKEND.replace(/\/$/, "")}/api/v1/usage`;
  try {
    const headers = {};
    if (req.headers.authorization) headers["Authorization"] = req.headers.authorization;
    const upstream = await fetch(url, { method: req.method, headers, signal: AbortSignal.timeout(15000) });
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
