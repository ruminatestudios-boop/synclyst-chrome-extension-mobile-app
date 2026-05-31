const BACKEND = process.env.NEXT_PUBLIC_API_URL || process.env.AURALINK_BACKEND_URL || "https://auralink-api-299567386855.us-central1.run.app";
export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ detail: 'Method not allowed' }); return; }
  try {
    const resp = await fetch(`${BACKEND.replace(/\/$/, '')}/api/v1/ebay/market-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(req.headers['x-synclyst-anon-id'] ? { 'X-SyncLyst-Anon-Id': req.headers['x-synclyst-anon-id'] } : {}) },
      body: JSON.stringify(req.body),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch(e) {
    res.status(502).json({ detail: 'eBay search failed', error: String(e) });
  }
}
