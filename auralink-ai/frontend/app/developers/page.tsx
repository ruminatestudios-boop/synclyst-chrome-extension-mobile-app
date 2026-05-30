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
  page: "min-h-screen text-white font-sans",
  nav: "px-6 py-4 flex items-center justify-between max-w-6xl mx-auto",
  logo: "font-bold text-lg tracking-tight",
  navLinks: "flex items-center gap-5 text-sm text-white/50",
  hero: "max-w-4xl mx-auto px-6 pt-24 pb-16 text-center",
  badge: "inline-flex items-center gap-2 text-emerald-400 text-xs font-medium px-3 py-1 rounded-full mb-6",
  h1: "text-4xl sm:text-5xl font-bold tracking-tight mb-4",
  sub: "text-white/40 text-lg max-w-2xl mx-auto mb-10",
  btnPrimary: "bg-white text-black font-semibold px-6 py-3 rounded-full hover:bg-zinc-100 transition text-sm",
  btnOutline: "text-white font-semibold px-6 py-3 rounded-full transition text-sm",
  section: "max-w-5xl mx-auto px-6 py-16",
  sectionTitle: "text-2xl font-bold mb-2",
  sectionSub: "text-white/40 mb-10",
  card: "rounded-2xl overflow-hidden",
  tabBar: "flex",
  tab: (active: boolean) =>
    `px-4 py-2.5 text-sm font-medium transition cursor-pointer ${active ? "text-white border-b-2 border-[#6c2bd9]" : "text-white/30 hover:text-white/60"}`,
  code: "rounded-b-2xl p-4 text-xs text-white/60 font-mono overflow-x-auto whitespace-pre leading-relaxed",
  endpointCard: "rounded-2xl p-5 mb-4",
  method: (m: string) =>
    m === "POST"
      ? "bg-[#6c2bd9]/20 text-[#a78bfa] text-xs font-bold px-2 py-0.5 rounded-full"
      : "bg-emerald-500/20 text-emerald-400 text-xs font-bold px-2 py-0.5 rounded-full",
  price: "text-amber-300 text-xs font-medium px-2 py-0.5 rounded-full",
  pricingGrid: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4",
  pricingCard: (highlighted: boolean) =>
    `rounded-2xl p-6 flex flex-col ${highlighted ? "" : ""}`,
  faqQ: "text-white font-medium mb-1 text-sm",
  faqA: "text-white/40 text-sm",
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

  const cardStyle = {
    background: "rgba(255,255,255,0.035)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "20px",
  };

  const codeBlockStyle = {
    background: "rgba(0,0,0,0.4)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: "0 0 16px 16px",
  };

  return (
    <div className={s.page} style={{ background: "#07050d", fontFamily: "Inter, system-ui, sans-serif" }}>

      {/* Nav */}
      <nav
        className="sticky top-0 z-40 backdrop-blur-md"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.07)", background: "rgba(7,5,13,0.85)" }}
      >
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="font-bold text-lg tracking-tight">
            SyncLyst<sup className="text-[10px] font-medium ml-0.5 opacity-60">®</sup>
          </Link>
          <div
            className="hidden sm:flex items-center gap-1 px-1 py-1"
            style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: "28px" }}
          >
            {[
              { label: "Endpoints", href: "#endpoints" },
              { label: "Pricing", href: "#pricing" },
              { label: "FAQ", href: "#faq" },
              { label: "Dashboard", href: "/developers/dashboard" },
            ].map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="px-4 py-1 text-sm text-white/50 hover:text-white transition-colors rounded-full"
              >
                {item.label}
              </a>
            ))}
          </div>
          <Link
            href="/developers/dashboard"
            className="text-sm font-semibold px-5 py-2 rounded-full transition-colors bg-white text-black hover:bg-zinc-100"
          >
            Get API Key
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-24 pb-16 text-center">
        <div
          className="inline-flex items-center gap-2 text-emerald-400 text-xs font-medium px-3 py-1 rounded-full mb-6"
          style={{ background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.2)" }}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
          Public API — Live
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">Build with Synclyst API</h1>
        <p className="text-white/40 text-lg max-w-2xl mx-auto mb-10">
          Add AI product extraction to your app. Extract titles, descriptions, prices, categories,
          and market values from any product photo. Free to start. Live in minutes.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link
            href="/developers/dashboard"
            className="bg-white text-black font-semibold px-6 py-3 rounded-full hover:bg-zinc-100 transition text-sm"
          >
            Get free API key
          </Link>
          <a
            href="#endpoints"
            className="text-white font-semibold px-6 py-3 rounded-full transition text-sm"
            style={{ border: "1px solid rgba(255,255,255,0.18)" }}
          >
            View endpoints
          </a>
        </div>
      </section>

      {/* Quick start */}
      <section className={s.section} id="quickstart">
        <h2 className={s.sectionTitle}>Quick start</h2>
        <p className={s.sectionSub}>Make your first API call in under 60 seconds.</p>

        <div style={cardStyle}>
          <div
            className="flex"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
          >
            {(["curl", "js", "python"] as const).map((t) => (
              <button key={t} onClick={() => setQuickTab(t)} className={s.tab(quickTab === t)}>
                {t === "js" ? "JavaScript" : t === "python" ? "Python" : "curl"}
              </button>
            ))}
          </div>
          <pre className="p-4 text-xs text-white/60 font-mono overflow-x-auto whitespace-pre leading-relaxed" style={{ borderRadius: "0 0 20px 20px" }}>
            {quickTab === "curl" ? CURL_EXTRACT : quickTab === "js" ? JS_EXTRACT : PY_EXTRACT}
          </pre>
        </div>

        <div className="mt-4 p-5 rounded-2xl" style={cardStyle}>
          <p className="text-sm text-white/40 mb-3 font-medium">Example response</p>
          <pre className="text-xs text-white/60 font-mono overflow-x-auto whitespace-pre leading-relaxed">
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
          <code
            className="px-1.5 py-0.5 rounded-lg text-xs font-mono text-[#a78bfa]"
            style={{ background: "rgba(108,43,217,0.15)" }}
          >
            Authorization: Bearer sk_live_YOUR_KEY
          </code>
        </p>

        {endpoints.map((ep) => (
          <div key={ep.path} className="p-5 mb-4 rounded-2xl" style={cardStyle}>
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <span className={s.method(ep.method)}>{ep.method}</span>
              <code className="text-sm font-mono text-white">{ep.path}</code>
              <span
                className="text-amber-300 text-xs font-medium px-2 py-0.5 rounded-full"
                style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.2)" }}
              >
                {ep.price}
              </span>
            </div>
            <p className="text-white/40 text-sm mb-4">{ep.desc}</p>

            <table className="w-full text-xs mb-4">
              <thead>
                <tr className="text-left text-white/20" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <th className="pb-1 pr-4 font-medium">Parameter</th>
                  <th className="pb-1 pr-4 font-medium">Type</th>
                  <th className="pb-1 pr-4 font-medium">Required</th>
                  <th className="pb-1 font-medium">Description</th>
                </tr>
              </thead>
              <tbody>
                {ep.params.map((p) => (
                  <tr key={p.name} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <td className="py-1.5 pr-4 font-mono text-white/60">{p.name}</td>
                    <td className="py-1.5 pr-4 text-white/30">{p.type}</td>
                    <td className="py-1.5 pr-4">
                      {p.req
                        ? <span className="text-emerald-400">required</span>
                        : <span className="text-white/20">optional</span>
                      }
                    </td>
                    <td className="py-1.5 text-white/40">{p.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <pre
              className="p-3 text-xs text-white/50 font-mono overflow-x-auto whitespace-pre leading-relaxed rounded-xl"
              style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.05)" }}
            >
              {ep.codeExample}
            </pre>
          </div>
        ))}
      </section>

      {/* Error reference */}
      <section className={s.section} id="errors">
        <h2 className={s.sectionTitle}>Error codes</h2>
        <p className={s.sectionSub}>All errors return consistent JSON with a machine-readable code.</p>
        <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
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
              className="flex items-start gap-4 px-5 py-3 text-sm"
              style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent" }}
            >
              <span className="text-white/25 font-mono w-8 shrink-0">{e.status}</span>
              <code className="text-amber-300 font-mono w-48 shrink-0 text-xs">{e.code}</code>
              <span className="text-white/40">{e.desc}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Sandbox */}
      <section className={s.section} id="sandbox">
        <h2 className={s.sectionTitle}>Sandbox</h2>
        <p className={s.sectionSub}>
          Test without calling AI or consuming credits. Generate a{" "}
          <code className="text-[#a78bfa] px-1.5 py-0.5 rounded-lg text-xs font-mono" style={{ background: "rgba(108,43,217,0.15)" }}>sk_test_</code> key in
          your dashboard, then use{" "}
          <code className="text-[#a78bfa] px-1.5 py-0.5 rounded-lg text-xs font-mono" style={{ background: "rgba(108,43,217,0.15)" }}>
            api.synclyst.app/sandbox/v1/
          </code>{" "}
          endpoints.
        </p>
        <pre
          className="p-4 text-xs text-white/50 font-mono overflow-x-auto whitespace-pre leading-relaxed rounded-2xl"
          style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)" }}
        >
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
        <p className={s.sectionSub}>Start free, no card required. Upgrade when you need more.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className="p-6 flex flex-col rounded-2xl"
              style={{
                background: plan.highlight ? "rgba(108,43,217,0.15)" : "rgba(255,255,255,0.035)",
                border: plan.highlight ? "1px solid rgba(108,43,217,0.4)" : "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <div className="mb-4">
                <p className="text-sm text-white/40 mb-1">{plan.name}</p>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold">{plan.price}</span>
                  <span className="text-white/30 text-sm">{plan.period}</span>
                </div>
              </div>
              <ul className="text-sm text-white/40 space-y-2 flex-1 mb-6">
                <li className="text-white font-medium">{plan.calls}</li>
                <li>{plan.rate}</li>
                <li className="text-xs">{plan.overage}</li>
              </ul>
              <Link
                href="/developers/dashboard"
                className="text-center py-2.5 px-4 rounded-full font-medium text-sm transition"
                style={
                  plan.highlight
                    ? { background: "#6c2bd9", color: "#fff" }
                    : { border: "1px solid rgba(255,255,255,0.15)", color: "#fff" }
                }
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>
        <p className="text-center text-white/25 text-sm mt-6">
          Per-call pricing: extract $0.05 · market-value $0.10 · classify $0.02 · value $0.03
        </p>
      </section>

      {/* FAQ */}
      <section className={s.section} id="faq">
        <h2 className={s.sectionTitle}>FAQ</h2>
        <div className="space-y-5 mt-8">
          {faqs.map((f) => (
            <div
              key={f.q}
              className="p-5 rounded-2xl"
              style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)" }}
            >
              <p className="text-white font-medium mb-1 text-sm">{f.q}</p>
              <p className="text-white/40 text-sm">{f.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
      <section
        className="max-w-5xl mx-auto px-6 py-16 text-center"
        style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}
      >
        <h2 className="text-2xl font-bold mb-3">Ready to build?</h2>
        <p className="text-white/40 mb-8">Free API key. No card required. First 100 calls on us.</p>
        <Link
          href="/developers/dashboard"
          className="bg-white text-black font-semibold px-8 py-3 rounded-full hover:bg-zinc-100 transition text-sm"
        >
          Get your free API key
        </Link>
      </section>

      <footer
        className="py-8 text-center text-sm"
        style={{ borderTop: "1px solid rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.2)" }}
      >
        © {new Date().getFullYear()} Synclyst ·{" "}
        <Link href="/privacy" className="hover:text-white/50 transition">Privacy</Link>
        {" · "}
        <Link href="/terms" className="hover:text-white/50 transition">Terms</Link>
      </footer>
    </div>
  );
}
