/**
 * Proxies external images (eBay CDN etc.) through the same origin so the
 * browser never makes a cross-origin request and eBay CDN images load without
 * CORS / mixed-content issues in reseller-results.html.
 *
 * Usage: GET /api/v1/vision/proxy-image?url=<encoded-image-url>
 */

const ALLOWED_HOSTS = [
  "i.ebayimg.com",
  "ebayimg.com",          // covers i.ebayimg.com, galleryplus.ebayimg.com, etc.
  "ebaystatic.com",       // covers thumbs.ebaystatic.com, thumbs2.ebaystatic.com, ir.ebaystatic.com, etc.
  "galleryplus.ebayimg.com",
  "photos.zillowstatic.com", // future-proofing
];

function isAllowed(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl);
    return ALLOWED_HOSTS.some(
      (h) => hostname === h || hostname.endsWith("." + h)
    );
  } catch {
    return false;
  }
}

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

  const { url } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ detail: "Missing ?url= parameter" });
  }

  if (!isAllowed(url)) {
    return res.status(403).json({ detail: "Image host not allowed" });
  }

  try {
    const abort = new AbortController();
    const tid = setTimeout(() => abort.abort(), 10_000);

    const upstream = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 SyncLyst/1.0" },
      signal: abort.signal,
    });
    clearTimeout(tid);

    if (!upstream.ok) {
      return res.status(upstream.status).json({ detail: "Upstream error" });
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).send(buffer);
  } catch (e) {
    const isAbort = e?.name === "AbortError";
    res
      .status(502)
      .json({ detail: isAbort ? "Image fetch timed out" : "Could not fetch image" });
  }
}
