"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { apiFetch, API_BASE } from "@/lib/api";

const MARKETPLACES = [
  { id: "shopify", name: "Shopify", logo: "https://www.google.com/s2/favicons?domain=shopify.com&sz=128", connect: true },
  { id: "amazon", name: "Amazon", logo: "https://www.google.com/s2/favicons?domain=amazon.com&sz=128", connect: false },
  { id: "tiktok", name: "TikTok Shop", logo: "https://www.google.com/s2/favicons?domain=tiktok.com&sz=128", connect: false },
  { id: "ebay", name: "eBay", logo: "/assets/ebay-logo.png", connect: false },
  { id: "etsy", name: "Etsy", logo: "https://www.google.com/s2/favicons?domain=etsy.com&sz=128", connect: false },
  { id: "vinted", name: "Vinted", logo: "https://www.google.com/s2/favicons?domain=vinted.com&sz=128", connect: false },
] as const;

export default function DashboardGuest() {
  const [pushProductId, setPushProductId] = useState<string | null>(null);
  const [products, setProducts] = useState<{ id: string; copy_seo_title?: string }[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState<string | null>("shopify");
  const [usage, setUsage] = useState<{ free_scans_used: number; free_scans_limit: number; can_scan: boolean } | null>(null);
  const [pushProductTitle, setPushProductTitle] = useState<string | null>(null);
  const [pushChannels, setPushChannels] = useState<string[]>(["shopify"]);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushMessage, setPushMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [pushSuccessResult, setPushSuccessResult] = useState<{
    productTitle: string;
    queued: { channel: string; shop_domain?: string; task_id?: string }[];
  } | null>(null);
  const [simulatedStores, setSimulatedStores] = useState<string[]>([]);
  const [connectStoreSuccess, setConnectStoreSuccess] = useState<string | null>(null);
  const [apiConnected, setApiConnected] = useState<boolean | null>(null);
  const [shopifyConnected, setShopifyConnected] = useState(false);
  const [shopifyShopDomain, setShopifyShopDomain] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    fetch(`${API_BASE}/health`, { signal: ac.signal })
      .then((r) => r.ok)
      .then(setApiConnected)
      .catch(() => setApiConnected(false))
      .finally(() => clearTimeout(t));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("push_product");
    if (fromUrl) setPushProductId(fromUrl);
  }, []);

  useEffect(() => {
    setProductsLoading(true);
    apiFetch("/api/v1/products", {})
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { id: string; copy_seo_title?: string }[]) => setProducts(Array.isArray(list) ? list : []))
      .catch(() => setProducts([]))
      .finally(() => setProductsLoading(false));
  }, []);

  useEffect(() => {
    // Shopify connection is owned by the publishing service (not the backend API).
    fetch("/api/publishing/token")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const token = d?.token;
        if (!token) return null;
        return fetch("/__synclyst_publishing/api/user/connected-stores", {
          headers: { Authorization: `Bearer ${token}` },
        });
      })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((stores) => {
        const s = stores?.shopify;
        const connected = s && s.status === "connected";
        setShopifyConnected(!!connected);
        setShopifyShopDomain(connected ? String(s.shop_domain || s.shop_id || "") : null);
        if (!connected) {
          setPushChannels((prev) => prev.filter((c) => c !== "shopify"));
        }
      })
      .catch(() => {
        setShopifyConnected(false);
        setShopifyShopDomain(null);
        setPushChannels((prev) => prev.filter((c) => c !== "shopify"));
      });
    apiFetch("/api/v1/usage", {})
      .then((r) => (r.ok ? r.json() : null))
      .then((u: Record<string, unknown> | null) => {
        if (!u) {
          setUsage(null);
          return;
        }
        const used =
          typeof u.scans_used === "number"
            ? u.scans_used
            : typeof u.free_scans_used === "number"
              ? u.free_scans_used
              : 0;
        const limit =
          typeof u.scans_limit === "number"
            ? u.scans_limit
            : typeof u.free_scans_limit === "number"
              ? u.free_scans_limit
              : 3;
        const can =
          typeof u.can_scan === "boolean" ? u.can_scan : used < limit;
        setUsage({ free_scans_used: used, free_scans_limit: limit, can_scan: can });
      })
      .catch(() => setUsage(null));
  }, []);

  useEffect(() => {
    if (!pushProductId) return;
    apiFetch(`/api/v1/products/${pushProductId}`, {})
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { copy_seo_title?: string } | null) => setPushProductTitle(p?.copy_seo_title ?? "Draft"))
      .catch(() => setPushProductTitle("Draft"));
  }, [pushProductId]);

  const togglePushChannel = (id: string) => {
    if (id === "shopify" && !hasShopifyConnected) return;
    setPushChannels((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const handlePushToDrafts = async () => {
    if (!pushProductId || pushChannels.length === 0) return;
    setPushLoading(true);
    setPushMessage(null);
    setPushSuccessResult(null);
    try {
      const res = await apiFetch(`/api/v1/products/${pushProductId}/push-drafts`, {
        method: "POST",
        body: JSON.stringify({ channels: pushChannels, as_draft: true }),
      });
      const data = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || "Push failed");
      }
      setPushSuccessResult({
        productTitle: pushProductTitle ?? "Draft",
        queued: (data?.queued ?? []).map((q: { channel?: string; shop_domain?: string; task_id?: string }) => ({
          channel: q.channel ?? "shopify",
          shop_domain: q.shop_domain,
          task_id: q.task_id,
        })),
      });
      setPushMessage(null);
    } catch (e) {
      setPushSuccessResult(null);
      setPushMessage({
        type: "error",
        text: e instanceof Error ? e.message : "Push to drafts failed",
      });
    } finally {
      setPushLoading(false);
    }
  };

  const resetPushFlow = () => {
    setPushSuccessResult(null);
    setPushMessage(null);
    setPushProductId(null);
    setPushProductTitle(null);
    setPushChannels(["shopify"]);
  };

  const connectedShopDomains = [
    ...(shopifyShopDomain ? [shopifyShopDomain] : []),
    ...simulatedStores,
  ];
  const hasShopifyConnected = connectedShopDomains.length > 0;

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", color: "#18181b" }}>
      <header className="glass-nav" style={{ padding: "1rem 2rem", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <Link href="/landing.html" style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text)" }}>
          SyncLyst
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", fontSize: "0.8125rem", color: "var(--muted)", flexWrap: "wrap" }}>
          <span title="Backend API">API: {API_BASE}</span>
          {apiConnected === true && (
            <span style={{ color: "#16a34a", fontWeight: 600 }}>● Connected</span>
          )}
          {apiConnected === false && (
            <span style={{ color: "#dc2626", fontWeight: 600 }} title="Start backend: cd auralink-ai/backend && source .venv/bin/activate && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000">
              ● Not connected — start backend on port 8000
            </span>
          )}
          {apiConnected === null && (
            <span style={{ color: "#ca8a04", fontWeight: 500 }}>● Checking…</span>
          )}
          <span>Guest</span>
        </div>
      </header>
      <main style={{ padding: "2rem", maxWidth: "64rem", margin: "0 auto" }}>
        <div style={{ marginBottom: "2rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text)", marginBottom: "0.25rem", letterSpacing: "-0.02em" }}>Dashboard</h1>
          <p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>Push to channels · Connect marketplaces</p>
          {usage !== null && (
            <p style={{ marginTop: "0.5rem", fontSize: "0.8125rem", color: "var(--muted)" }}>
              🔍 {Math.max(0, usage.free_scans_limit - usage.free_scans_used)} of {usage.free_scans_limit} free scans left today
            </p>
          )}
          {usage?.can_scan && usage.free_scans_used === 0 && (
            <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", display: "inline-block" }}>
              <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "#166534" }}>✨ {usage.free_scans_limit} free scans today — resets daily</span>
            </div>
          )}
          {usage && !usage.can_scan && (
            <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", display: "inline-block" }}>
              <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "#991b1b" }}>Daily free scans used up.</span>
              <Link href="/scan?buy=1" style={{ display: "block", marginTop: "0.5rem", fontSize: "0.875rem", fontWeight: 700, color: "#2563eb" }}>Get 20 extra scans — $1.99 →</Link>
            </div>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "1.5rem" }}>
          <section className="glass-card" style={{ padding: "1.5rem", gridColumn: "1 / -1" }}>
            <h3 className="section-label">Push to drafts</h3>
            {pushSuccessResult ? (
              <div style={{ textAlign: "center", padding: "1rem 0" }}>
                <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#dcfce7", border: "2px solid #22c55e", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 1.25rem", fontSize: "1.75rem" }} aria-hidden>✓</div>
                <h2 style={{ fontSize: "1.375rem", fontWeight: 700, color: "var(--text)", marginBottom: "0.25rem", letterSpacing: "-0.02em" }}>Pushed to drafts</h2>
                <p style={{ color: "var(--muted)", fontSize: "0.9375rem", marginBottom: "1.5rem" }}>
                  &quot;{pushSuccessResult.productTitle}&quot; was sent to all selected shops.
                </p>
                <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "12px", padding: "1.25rem 1.5rem", marginBottom: "1.5rem", textAlign: "left", maxWidth: "24rem", marginLeft: "auto", marginRight: "auto" }}>
                  <p style={{ fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", marginBottom: "0.75rem" }}>Sent to</p>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {pushSuccessResult.queued.map((q, i) => {
                      const label = q.channel === "shopify" && q.shop_domain
                        ? `Shopify: ${q.shop_domain}`
                        : q.channel;
                      const adminUrl = q.channel === "shopify" && q.shop_domain
                        ? `https://${q.shop_domain.replace(/^https?:\/\//, "").split("/")[0]}/admin/products`
                        : null;
                      return (
                        <li key={i} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.35rem 0", fontSize: "0.875rem", color: "var(--text)" }}>
                          <span style={{ color: "#22c55e", fontWeight: 700 }}>✓</span>
                          {adminUrl ? (
                            <a href={adminUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", fontWeight: 500 }}>{label}</a>
                          ) : (
                            <span>{label}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <p style={{ fontSize: "0.875rem", color: "var(--muted)", marginBottom: "1.5rem", maxWidth: "28rem", marginLeft: "auto", marginRight: "auto" }}>
                  Review each listing in the platform admin and publish when ready.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", justifyContent: "center" }}>
                  <button type="button" onClick={resetPushFlow} className="glass-cta" style={{ padding: "0.625rem 1.25rem", borderRadius: "8px", fontWeight: 600, cursor: "pointer", color: "#fff" }}>
                    Push another product
                  </button>
                  <Link href="/dashboard/products" style={{ padding: "0.625rem 1.25rem", borderRadius: "8px", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontWeight: 600, fontSize: "0.875rem", textDecoration: "none" }}>
                    View master products
                  </Link>
                </div>
              </div>
            ) : (
              <div>
            <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
              Select one or more channels below. One click pushes to all selected (unified push).
            </p>
            <p style={{ color: "var(--muted)", fontSize: "0.8125rem", marginBottom: "1rem" }}>
              Then review on each platform (e.g. Shopify admin) and push live there.
            </p>
            {!pushProductId ? (
              <div style={{ marginBottom: "1rem" }}>
                <label htmlFor="push-product-select" style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600, color: "var(--text)", marginBottom: "0.5rem" }}>
                  Product to push
                </label>
                <select
                  id="push-product-select"
                  value=""
                  onChange={(e) => setPushProductId(e.target.value || null)}
                  style={{ padding: "0.5rem 0.75rem", borderRadius: "8px", border: "1px solid var(--border)", background: "#fff", color: "var(--text)", minWidth: "16rem" }}
                  disabled={productsLoading}
                >
                  <option value="">— Select product —</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.copy_seo_title || p.id}</option>
                  ))}
                </select>
                {productsLoading && <span style={{ marginLeft: "0.5rem", fontSize: "0.8125rem", color: "var(--muted)" }}>Loading…</span>}
              </div>
            ) : (
              <>
                <p style={{ fontWeight: 600, color: "var(--text)", marginBottom: "1rem" }}>
                  &quot;{pushProductTitle ?? "…"}&quot;
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center", marginBottom: "1rem" }}>
                  {MARKETPLACES.map((m) => {
                    const isShopify = m.id === "shopify";
                    const connected = isShopify && hasShopifyConnected;
                    const available = isShopify && connected;
                    const checked = pushChannels.includes(m.id);
                    return (
                      <label
                        key={m.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                          padding: "0.5rem 0.75rem",
                          background: available ? "var(--surface)" : "#f4f4f5",
                          border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
                          borderRadius: "8px",
                          cursor: available ? "pointer" : "default",
                          opacity: available ? 1 : 0.7,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePushChannel(m.id)}
                          disabled={!available}
                          style={{ width: "1rem", height: "1rem" }}
                        />
                        <img src={m.logo} alt="" width={20} height={20} style={{ objectFit: "contain" }} />
                        <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>{m.name}</span>
                        {!available && <span style={{ fontSize: "0.7rem", color: "var(--muted)" }}>Coming soon</span>}
                      </label>
                    );
                  })}
                </div>
                {pushMessage && (
                  <p
                    style={{
                      padding: "0.75rem 1rem",
                      marginBottom: "1rem",
                      background: pushMessage.type === "success" ? "#f0fdf4" : "#fef2f2",
                      border: `1px solid ${pushMessage.type === "success" ? "#bbf7d0" : "#fecaca"}`,
                      borderRadius: "8px",
                      fontSize: "0.875rem",
                      color: pushMessage.type === "success" ? "#166534" : "#991b1b",
                    }}
                  >
                    {pushMessage.text}
                  </p>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={handlePushToDrafts}
                    disabled={pushLoading || pushChannels.length === 0}
                    className="glass-cta"
                    style={{ padding: "0.5rem 1.25rem", borderRadius: "8px", fontWeight: 600, cursor: pushLoading || pushChannels.length === 0 ? "not-allowed" : "pointer", color: "#fff" }}
                  >
                    {pushLoading ? "Pushing…" : "Push to drafts"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPushProductId(null)}
                    style={{ padding: "0.5rem 1rem", borderRadius: "8px", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--muted)", fontSize: "0.875rem", cursor: "pointer" }}
                  >
                    Change product
                  </button>
                </div>
              </>
            )}
              </div>
            )}
          </section>
          <section id="connect-marketplaces" className="glass-card" style={{ padding: "1.5rem", gridColumn: "1 / -1" }}>
            <h3 className="section-label">Connect your marketplaces</h3>
            {connectStoreSuccess ? (
              <div style={{ textAlign: "center", padding: "1.5rem 0" }}>
                <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#dcfce7", border: "2px solid #22c55e", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 1.25rem", fontSize: "1.75rem" }} aria-hidden>✓</div>
                <h2 style={{ fontSize: "1.375rem", fontWeight: 700, color: "var(--text)", marginBottom: "0.25rem", letterSpacing: "-0.02em" }}>Store connected</h2>
                <p style={{ color: "var(--muted)", fontSize: "0.9375rem", marginBottom: "1rem" }}>
                  <strong style={{ color: "var(--text)" }}>{connectStoreSuccess}</strong> is now connected. You can push products to this store from Push to drafts.
                </p>
                <button
                  type="button"
                  onClick={() => setConnectStoreSuccess(null)}
                  className="glass-cta"
                  style={{ padding: "0.625rem 1.25rem", borderRadius: "8px", fontWeight: 600, cursor: "pointer", color: "#fff" }}
                >
                  Done
                </button>
              </div>
            ) : (
              <div>
            <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginBottom: "1rem" }}>
              Choose where to sync your listings. Click a channel to connect.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: "0.75rem" }}>
              {MARKETPLACES.map((m) => {
                const isShopify = m.id === "shopify";
                const connected = isShopify && shopifyConnected;
                const available = isShopify;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => available && setSelectedChannel(m.id)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "1rem 0.75rem",
                      background: selectedChannel === m.id ? "#f4f4f5" : "var(--surface)",
                      color: selectedChannel === m.id ? "var(--text)" : "var(--text)",
                      border: `1px solid ${selectedChannel === m.id ? "#a1a1aa" : "var(--border)"}`,
                      borderRadius: "12px",
                      cursor: available ? "pointer" : "default",
                      opacity: available ? 1 : 0.45,
                    }}
                    title={available ? (connected ? `Connected: ${connectedShopDomains.join(", ")}` : "Connect") : "Coming soon"}
                  >
                    <img src={m.logo} alt="" width={32} height={32} style={{ objectFit: "contain", marginBottom: "0.5rem" }} />
                    <span style={{ fontSize: "0.75rem", fontWeight: 600 }}>{m.name}</span>
                    {connected && <span style={{ fontSize: "0.65rem", marginTop: "0.25rem", opacity: 0.9 }}>Connected</span>}
                    {!available && <span style={{ fontSize: "0.65rem", marginTop: "0.25rem", opacity: 0.7 }}>Coming soon</span>}
                  </button>
                );
              })}
            </div>
            {selectedChannel === "shopify" && (
              <div style={{ marginTop: "1.25rem", paddingTop: "1.25rem", borderTop: "1px solid var(--border)" }}>
                <h4 style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--text)", marginBottom: "0.5rem" }}>Connect Shopify</h4>
                {shopifyConnected ? (
                  <p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
                    Connected: {connectedShopDomains.join(", ")}. Add another store below.
                  </p>
                ) : null}
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "0.75rem" }}>
                  <button
                    type="button"
                    onClick={() => { window.location.href = "/shopify/launch?return=stores-list"; }}
                    className="glass-cta"
                    style={{ padding: "0.5rem 1rem", borderRadius: "8px", fontWeight: 600, cursor: "pointer", color: "#fff", width: "100%" }}
                  >
                    {shopifyConnected ? "Connect another store" : "Connect store"}
                  </button>
                </div>
              </div>
            )}
              </div>
            )}
          </section>
        </div>
        <p style={{ marginTop: "3rem", paddingTop: "1.5rem", borderTop: "1px solid var(--border)", textAlign: "center", color: "var(--muted)", fontSize: "0.8125rem" }}>
          Login will be added later.
        </p>
      </main>
    </div>
  );
}
