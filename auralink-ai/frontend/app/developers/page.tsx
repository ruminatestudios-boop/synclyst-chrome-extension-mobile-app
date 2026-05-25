"use client";

import { useState } from "react";
import Link from "next/link";

// ─── Code examples ────────────────────────────────────────────────────────────

const CURL_EXTRACT = `curl -X POST https://api.synclyst.app/v1/extract \\
  -H "Authorization: Bearer sk_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "image": "BASE64_IMAGE_HERE",
    "format": "raw"
  }'`;

const JS_EXTRACT = `const response = await fetch("https://api.synclyst.app/v1/extract", {
  method: "POST",
  headers: {
    "Authorization": "Bearer sk_live_YOUR_KEY",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    image: imageBase64,
    format: "shopify", // raw | shopify | ebay | etsy
  }),
});

const { data } = await response.json();
console.log(data.title); // "Nike Air Force 1 Low White"
console.log(data.price); // 65.00`;

const PY_EXTRACT = `import requests, base64

with open("product.jpg", "rb") as f:
    image_b64 = base64.b64encode(f.read()).decode()

resp = requests.post(
    "https://api.synclyst.app/v1/extract",
    headers={"Authorization": "Bearer sk_live_YOUR_KEY"},
    json={"image": image_b64, "format": "raw"},
)

data = resp.json()["data"]
print(data["title"])   # Nike Air Force 1 Low White
print(data["price"])   # 65.0`;

const CURL_MARKET = `curl "https://api.synclyst.app/v1/market-value?category=Sneakers&brand=Nike&condition=good" \\
  -H "Authorization: Bearer sk_live_YOUR_KEY"`;

const CURL_CLASSIFY = `curl -X POST https://api.synclyst.app/v1/classify \\
  -H "Authorization: Bearer sk_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"image": "BASE64_IMAGE_HERE"}'`;

const CURL_VALUE = `curl -X POST https://api.synclyst.app/v1/value \\
  -H "Authorization: Bearer sk_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"image": "BASE64_IMAGE_HERE", "condition": "good"}'`;

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  page: "min-h-screen bg-[#0a0a0b] text-white font-sans",
  nav: "border-b border-white/10 px-6 py-4 flex items-center justify-between max-w-6xl mx-auto",
  logo: "font-bold text-lg tracking-tight",
  navLinks: "flex items-center gap-6 text-sm text-zinc-400",
  hero: "max-w-4xl mx-auto px-6 pt-24 pb-16 text-center",
  badge: "inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium px-3 py-1 rounded-full mb-6",
  h1: "text-4xl sm:text-5xl font-bold tracking-tight mb-4",
  sub: "text-zinc-400 text-lg max-w-2xl mx-auto mb-10",
  btnPrimary: "bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-zinc-100 transition text-sm",
  btnOutline: "border border-white/20 text-white font-semibold px-6 py-3 rounded-lg hover:bg-white/5 transition text-sm",
  section: "max-w-5xl mx-auto px-6 py-16",
  sectionTitle: "text-2xl font-bold mb-2",
  sectionSub: "text-zinc-400 mb-10",
  card: "bg-zinc-900 border border-white/10 rounded-xl overflow-hidden",
  tabBar: "flex border-b border-white/10",
  tab: (active: boolean) =>
    `px-4 py-2.5 text-sm font-medium transition cursor-pointer ${active ? "text-white border-b-2 border-white" : "text-zinc-500 hover:text-zinc-300"}`,
  code: "bg-[#111] rounded-b-xl p-4 text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre leading-relaxed",
  endpointCard: "bg-zinc-900 border border-white/10 rounded-xl p-5 mb-4",
  method: (m: string) =>
    m === "POST"
      ? "bg-blue-500/20 text-blue-400 text-xs font-bold px-2 py-0.5 rounded"
      : "bg-emerald-500/20 text-emerald-400 text-xs font-bold px-2 py-0.5 rounded",
  price: "bg-amber-500/10 text-amber-400 text-xs font-medium px-2 py-0.5 rounded border border-amber-500/20",
  pricingGrid: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4",
  pricingCard: (highlighted: boolean) =>
    `rounded-xl border p-6 flex flex-col ${highlighted ? "border-white bg-white/5" : "border-white/10 bg-zinc-900"}`,
  faqQ: "text-white font-medium mb-1 text-sm",
  faqA: "text-zinc-400 text-sm",
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function DevelopersPage() {
  const [quickTab, setQuickTab] = useState<"curl" | "js" | "python">("curl");

  const endpoints = [
    {
      method: "POST",
      path: "/v1/extract",
      desc: "Extract complete product listing data from a photo. Returns title, description, price, category, brand, condition, tags, and estimated value range.",
      price: "$0.05 / call",
      params: [
        { name: "image", type: "string", req: true, desc: "Base64-encoded product image" },
        { name: "format", type: "string", req: false, desc: "raw | shopify | ebay | etsy (default: raw)" },
        { name: "language", type: "string", req: false, desc: "en | th | de | fr | es (default: en)" },
        { name: "webhook_url", type: "string", req: false, desc: "Optional — returns job_id instantly, POSTs results to URL async" },
      ],
      codeExample: CURL_EXTRACT,
    },
    {
      method: "GET",
      path: "/v1/market-value",
      desc: "Real market pricing data from recent sold listings. Returns price range, average sold price, demand level, best platform, and days to sell.",
      price: "$0.10 / call",
      params: [
        { name: "category", type: "string", req: true, desc: "Product category (e.g. Sneakers)" },
        { name: "brand", type: "string", req: true, desc: "Brand name (e.g. Nike)" },
        { name: "condition", type: "string", req: false, desc: "Product condition" },
        { name: "market", type: "string", req: false, desc: "uk | us | global (default: uk)" },
      ],
      codeExample: CURL_MARKET,
    },
    {
      method: "POST",
      path: "/v1/classify",
      desc: "Lightweight classification only. Returns category and subcategory. Cheaper than full extraction — use when you just need to sort products.",
      price: "$0.02 / call",
      params: [
        { name: "image", type: "string", req: true, desc: "Base64-encoded product image" },
      ],
      codeExample: CURL_CLASSIFY,
    },
    {
      method: "POST",
      path: "/v1/value",
      desc: "Estimated value only. Returns a price estimate and confidence level. Cheaper than full extraction — use for quick pricing decisions.",
      price: "$0.03 / call",
      params: [
        { name: "image", type: "string", req: true, desc: "Base64-encoded product image" },
        { name: "condition", type: "string", req: false, desc: "new | excellent | good | fair | poor" },
        { name: "market", type: "string", req: false, desc: "uk | us | global" },
      ],
      codeExample: CURL_VALUE,
    },
  ];

  const plans = [
    {
      name: "Free",
      price: "£0",
      period: "/month",
      calls: "100 calls/month",
      rate: "10 calls/minute",
      overage: "Blocked at limit",
      cta: "Get API Key",
      highlight: false,
    },
    {
      name: "Starter",
      price: "£19",
      period: "/month",
      calls: "1,000 calls/month",
      rate: "30 calls/minute",
      overage: "£0.07 per extra call",
      cta: "Start Building",
      highlight: false,
    },
    {
      name: "Pro",
      price: "£49",
      period: "/month",
      calls: "10,000 calls/month",
      rate: "100 calls/minute",
      overage: "£0.05 per extra call",
      cta: "Go Pro",
      highlight: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      period: "",
      calls: "Unlimited calls",
      rate: "500 calls/minute",
      overage: "Custom pricing",
      cta: "Contact Us",
      highlight: false,
    },
  ];

  const faqs = [
    {
      q: "Can I use this for any product?",
      a: "Yes. The API works on any physical product — clothing, sneakers, electronics, collectibles, furniture, and more. It's been trained on millions of resale listings.",
    },
    {
      q: "How accurate is the extraction?",
      a: "For clearly photographed branded products, accuracy is typically 85–95%. Results include a confidence_score field so you can decide when to ask users to confirm.",
    },
    {
      q: "What image formats are supported?",
      a: "JPEG, PNG, WebP, HEIC, AVIF, and GIF. Images must be under 10MB. For best results, use clear, well-lit photos of the product label or front.",
    },
    {
      q: "How do I handle errors?",
      a: "Every error response includes an error:true flag, a machine-readable code, and a human-readable message. Check the code field — QUOTA_EXCEEDED, RATE_LIMIT_EXCEEDED, EXTRACTION_FAILED, IMAGE_TOO_LARGE, INVALID_API_KEY.",
    },
    {
      q: "Is there a sandbox for testing?",
      a: "Yes. Generate a sk_test_ key in your dashboard. Use it at api.synclyst.app/sandbox/v1/ — returns realistic fake data, no AI is called, no credits consumed.",
    },
    {
      q: "Do I need a credit card for the free plan?",
      a: "No. The free plan gives you 100 calls/month with no card required. Upgrade when you need more.",
    },
  ];

  return (
    <div className={s.page}>
      {/* Nav */}
      <nav className={s.nav}>
        <Link href="/" className={s.logo}>
          <span style={{ color: "#fff" }}>Sync</span>
          <span style={{ color: "#a78bfa" }}>Lyst</span>
        </Link>
        <div className={s.navLinks}>
          <a href="#endpoints" className="hover:text-white transition">Endpoints</a>
          <a href="#pricing" className="hover:text-white transition">Pricing</a>
          <a href="#faq" className="hover:text-white transition">FAQ</a>
          <Link href="/developers/dashboard" className="hover:text-white transition">Dashboard</Link>
          <Link href="/developers/dashboard" className={s.btnPrimary} style={{ padding: "8px 18px" }}>
            Get API Key
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className={s.hero}>
        <div className={s.badge}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ade80", display: "inline-block" }} />
          Public API — Live
        </div>
        <h1 className={s.h1}>Build with Synclyst API</h1>
        <p className={s.sub}>
          Add AI product extraction to your app. Extract titles, descriptions, prices, categories,
          and market values from any product photo. Free to start. Live in minutes.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link href="/developers/dashboard" className={s.btnPrimary}>
            Get free API key
          </Link>
          <a href="#endpoints" className={s.btnOutline}>
            View endpoints
          </a>
        </div>
      </section>

      {/* Quick start */}
      <section className={s.section} id="quickstart">
        <h2 className={s.sectionTitle}>Quick start</h2>
        <p className={s.sectionSub}>Make your first API call in under 60 seconds.</p>

        <div className={s.card}>
          <div className={s.tabBar}>
            {(["curl", "js", "python"] as const).map((t) => (
              <button key={t} onClick={() => setQuickTab(t)} className={s.tab(quickTab === t)}>
                {t === "js" ? "JavaScript" : t === "python" ? "Python" : "curl"}
              </button>
            ))}
          </div>
          <pre className={s.code}>
            {quickTab === "curl" ? CURL_EXTRACT : quickTab === "js" ? JS_EXTRACT : PY_EXTRACT}
          </pre>
        </div>

        <div className="mt-6 bg-zinc-900 border border-white/10 rounded-xl p-5">
          <p className="text-sm text-zinc-400 mb-3 font-medium">Example response</p>
          <pre className="text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre leading-relaxed">
{`{
  "success": true,
  "data": {
    "title": "Nike Air Force 1 Low White Leather Sneakers",
    "brand": "Nike",
    "category": "Sneakers",
    "condition": "Used - Good",
    "price": 65.00,
    "price_currency": "GBP",
    "tags": ["nike", "air force 1", "trainers", "white"],
    "estimated_value_range": "£52-£78",
    "confidence_score": 0.92
  },
  "usage": {
    "calls_used": 1,
    "calls_remaining": 99,
    "plan": "free"
  }
}`}
          </pre>
        </div>
      </section>

      {/* Endpoints */}
      <section className={s.section} id="endpoints">
        <h2 className={s.sectionTitle}>Endpoints</h2>
        <p className={s.sectionSub}>
          All endpoints require{" "}
          <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-xs font-mono">
            Authorization: Bearer sk_live_YOUR_KEY
          </code>
        </p>

        {endpoints.map((ep) => (
          <div key={ep.path} className={s.endpointCard}>
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <span className={s.method(ep.method)}>{ep.method}</span>
              <code className="text-sm font-mono text-white">{ep.path}</code>
              <span className={s.price}>{ep.price}</span>
            </div>
            <p className="text-zinc-400 text-sm mb-4">{ep.desc}</p>

            <table className="w-full text-xs mb-4">
              <thead>
                <tr className="text-left text-zinc-600 border-b border-white/5">
                  <th className="pb-1 pr-4 font-medium">Parameter</th>
                  <th className="pb-1 pr-4 font-medium">Type</th>
                  <th className="pb-1 pr-4 font-medium">Required</th>
                  <th className="pb-1 font-medium">Description</th>
                </tr>
              </thead>
              <tbody>
                {ep.params.map((p) => (
                  <tr key={p.name} className="border-b border-white/5">
                    <td className="py-1.5 pr-4 font-mono text-zinc-300">{p.name}</td>
                    <td className="py-1.5 pr-4 text-zinc-500">{p.type}</td>
                    <td className="py-1.5 pr-4">
                      {p.req ? (
                        <span className="text-emerald-400">required</span>
                      ) : (
                        <span className="text-zinc-600">optional</span>
                      )}
                    </td>
                    <td className="py-1.5 text-zinc-400">{p.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <pre className="bg-[#111] rounded-lg p-3 text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre leading-relaxed">
              {ep.codeExample}
            </pre>
          </div>
        ))}
      </section>

      {/* Error reference */}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>Error codes</h2>
        <p className={s.sectionSub}>All errors return consistent JSON with a machine-readable code.</p>
        <div className="bg-zinc-900 border border-white/10 rounded-xl overflow-hidden">
          {[
            { status: "401", code: "MISSING_API_KEY", desc: "Authorization header not provided" },
            { status: "401", code: "INVALID_API_KEY", desc: "Key not found, revoked, or suspended" },
            { status: "429", code: "QUOTA_EXCEEDED", desc: "Monthly call limit reached — includes upgrade_url" },
            { status: "429", code: "RATE_LIMIT_EXCEEDED", desc: "Per-minute limit hit — includes Retry-After header" },
            { status: "400", code: "INVALID_REQUEST", desc: "Missing or invalid field — includes field name" },
            { status: "413", code: "IMAGE_TOO_LARGE", desc: "Image exceeds 10MB" },
            { status: "422", code: "EXTRACTION_FAILED", desc: "AI could not extract from this image" },
            { status: "500", code: "SERVER_ERROR", desc: "Unexpected server error — retry in a few seconds" },
          ].map((e, i) => (
            <div
              key={e.code}
              className={`flex items-start gap-4 px-5 py-3 text-sm ${i % 2 === 0 ? "bg-white/[0.02]" : ""}`}
            >
              <span className="text-zinc-500 font-mono w-8 shrink-0">{e.status}</span>
              <code className="text-amber-400 font-mono w-48 shrink-0 text-xs">{e.code}</code>
              <span className="text-zinc-400">{e.desc}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Sandbox */}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>Sandbox</h2>
        <p className={s.sectionSub}>
          Test without calling AI or consuming credits. Generate a{" "}
          <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-xs font-mono">sk_test_</code> key in
          your dashboard, then use{" "}
          <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-xs font-mono">
            api.synclyst.app/sandbox/v1/
          </code>{" "}
          endpoints.
        </p>
        <pre className="bg-[#111] border border-white/10 rounded-xl p-4 text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre leading-relaxed">
{`# Sandbox — use sk_test_ key and /sandbox/v1/ path
curl -X POST https://api.synclyst.app/sandbox/v1/extract \\
  -H "Authorization: Bearer sk_test_YOUR_TEST_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"image": "any_base64_here"}'

# Returns realistic fake data — _sandbox: true in response`}
        </pre>
      </section>

      {/* Pricing */}
      <section className={s.section} id="pricing">
        <h2 className={s.sectionTitle}>Pricing</h2>
        <p className={s.sectionSub}>
          Start free, no card required. Upgrade when you need more.
        </p>
        <div className={s.pricingGrid}>
          {plans.map((plan) => (
            <div key={plan.name} className={s.pricingCard(plan.highlight)}>
              <div className="mb-4">
                <p className="text-sm text-zinc-400 mb-1">{plan.name}</p>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold">{plan.price}</span>
                  <span className="text-zinc-500 text-sm">{plan.period}</span>
                </div>
              </div>
              <ul className="text-sm text-zinc-400 space-y-2 flex-1 mb-6">
                <li className="text-white font-medium">{plan.calls}</li>
                <li>{plan.rate}</li>
                <li className="text-xs">{plan.overage}</li>
              </ul>
              <Link
                href="/developers/dashboard"
                className={`text-center py-2.5 px-4 rounded-lg font-medium text-sm transition ${
                  plan.highlight
                    ? "bg-white text-black hover:bg-zinc-100"
                    : "border border-white/20 text-white hover:bg-white/5"
                }`}
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>

        <p className="text-center text-zinc-500 text-sm mt-6">
          Per-call pricing: extract $0.05 · market-value $0.10 · classify $0.02 · value $0.03
        </p>
      </section>

      {/* FAQ */}
      <section className={s.section} id="faq">
        <h2 className={s.sectionTitle}>FAQ</h2>
        <div className="space-y-6 mt-8">
          {faqs.map((f) => (
            <div key={f.q}>
              <p className={s.faqQ}>{f.q}</p>
              <p className={s.faqA}>{f.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
      <section className="max-w-5xl mx-auto px-6 py-16 text-center border-t border-white/10">
        <h2 className="text-2xl font-bold mb-3">Ready to build?</h2>
        <p className="text-zinc-400 mb-8">Free API key. No card required. First 100 calls on us.</p>
        <Link href="/developers/dashboard" className={s.btnPrimary}>
          Get your free API key
        </Link>
      </section>

      <footer className="border-t border-white/10 py-8 text-center text-zinc-600 text-sm">
        © {new Date().getFullYear()} Synclyst ·{" "}
        <Link href="/privacy" className="hover:text-zinc-400 transition">Privacy</Link>
        {" · "}
        <Link href="/terms" className="hover:text-zinc-400 transition">Terms</Link>
      </footer>
    </div>
  );
}
