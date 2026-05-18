const BACKEND =
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.AURALINK_BACKEND_URL ||
  process.env.NEXT_PUBLIC_SYNCLYST_BACKEND_URL ||
  process.env.SYNCLYST_BACKEND_URL ||
  "http://localhost:8000";

export const config = { api: { bodyParser: { sizeLimit: "32kb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ detail: "Method not allowed" });
  }
  const url = `${BACKEND.replace(/\/$/, "")}/api/v1/billing/guest-checkout`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    console.error("[billing/guest-checkout proxy]", e);
    res.status(502).json({ detail: "Billing service unavailable. Try again later." });
  }
}
