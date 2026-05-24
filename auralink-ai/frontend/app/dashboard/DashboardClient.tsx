"use client";

/**
 * Signed-in dashboard: uses Clerk (useUser, useAuth, UserButton).
 * Only use this when Clerk is re-enabled and user is signed in.
 * With Clerk disabled, the app uses DashboardGuest only (see dashboard/page.tsx).
 */
import { useUser, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import ApiKeyPanel from "./ApiKeyPanel";

const MARKETPLACES = [
  { id: "shopify", name: "Shopify", logo: "https://www.google.com/s2/favicons?domain=shopify.com&sz=128", connect: true },
  { id: "amazon", name: "Amazon", logo: "https://www.google.com/s2/favicons?domain=amazon.com&sz=128", connect: false },
  { id: "tiktok", name: "TikTok Shop", logo: "https://www.google.com/s2/favicons?domain=tiktok.com&sz=128", connect: false },
  { id: "ebay", name: "eBay", logo: "/assets/ebay-logo.png", connect: false },
  { id: "etsy", name: "Etsy", logo: "https://www.google.com/s2/favicons?domain=etsy.com&sz=128", connect: false },
  { id: "vinted", name: "Vinted", logo: "https://www.google.com/s2/favicons?domain=vinted.com&sz=128", connect: false },
] as const;

const CLERK_JWT_TEMPLATE = process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE?.trim();

/**
 * Get a Clerk JWT, trying the named template first and falling back to the
 * default session token. This prevents 401s when the JWT template doesn't
 * exist in the Clerk dashboard (e.g. new environments or misconfigured keys).
 */
async function getAuthToken(
  getToken: ReturnType<typeof useAuth>["getToken"]
): Promise<string | null> {
  if (!getToken) return null;
  if (CLERK_JWT_TEMPLATE) {
    try {
      const t = await getToken({ template: CLERK_JWT_TEMPLATE });
      if (t) return t;
    } catch {
      // Template not found — fall through to default
    }
  }
  return getToken();
}

export default function DashboardClient() {
  const { user } = useUser();
  const { isLoaded, getToken } = useAuth();
  const [pushProductId, setPushProductId] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string | null>("shopify");
  const [usage, setUsage] = useState<{ tier: string; scans_used: number; scans_limit: number; can_scan: boolean } | null>(null);
  const [pushProductTitle, setPushProductTitle] = useState<string | null>(null);
  const [pushChannels, setPushChannels] = useState<string[]>(["shopify"]);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushMessage, setPushMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [billingNotice, setBillingNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [shopifyConnected, setShopifyConnected] = useState(false);
  const [shopifyShopDomain, setShopifyShopDomain] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setPushProductId(params.get("push_product"));
  }, []);

  const fetchUsage = async () => {
    try {
      const token = await getAuthToken(getToken);
      const r = await apiFetch("/api/v1/usage", { token });
      setUsage(r.ok ? await r.json() : null);
    } catch {
      setUsage(null);
    }
  };

  useEffect(() => {
    if (!isLoaded) return;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 8000);
    fetch("/api/publishing/token", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const token = d?.token;
        if (!token) return null;
        return fetch("/__synclyst_publishing/api/user/connected-stores", {
          headers: { Authorization: `Bearer ${token}` },
          signal: ac.signal,
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
      })
      .finally(() => clearTimeout(timeout));
    fetchUsage();
  }, [isLoaded, getToken]);

  useEffect(() => {
    if (!isLoaded || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const billing = (params.get("billing") || "").toLowerCase();
    const sessionId = params.get("session_id") || "";
    if (billing !== "success" || !sessionId) return;

    const cleaned = new URL(window.location.href);
    cleaned.searchParams.delete("billing");
    cleaned.searchParams.delete("session_id");
    window.history.replaceState({}, "", cleaned.toString());

    (async () => {
      try {
        const token = await getAuthToken(getToken);
        const res = await apiFetch("/api/v1/billing/confirm", {
          method: "POST",
          token,
          body: JSON.stringify({ session_id: sessionId }),
        });
        if (res.ok) {
          await fetchUsage();
          setBillingNotice({ text: "Payment confirmed. Your plan is now active.", ok: true });
          return;
        }
      } catch {
        // fall through to polling
      }

      // Backend confirm failed — poll usage until tier upgrades (up to 30 s)
      setBillingNotice({ text: "Payment received. Activating your plan…", ok: true });
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const token = await getAuthToken(getToken);
          const r = await apiFetch("/api/v1/usage", { token });
          if (r.ok) {
            const u = await r.json();
            if (u?.tier && u.tier !== "starter") {
              setUsage(u);
              setBillingNotice({ text: `Payment confirmed. Your ${u.tier} plan is now active.`, ok: true });
              return;
            }
          }
        } catch {
          // keep polling
        }
      }
      setBillingNotice({ text: "Payment received. Your plan will activate within a few minutes.", ok: true });
    })();
  }, [isLoaded, getToken]);

  useEffect(() => {
    if (!pushProductId || !getToken) return;
    getAuthToken(getToken)
      .then((token) => apiFetch(`/api/v1/products/${pushProductId}`, { token }))
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { copy_seo_title?: string } | null) => setPushProductTitle(p?.copy_seo_title ?? "Draft"))
      .catch(() => setPushProductTitle("Draft"));
  }, [pushProductId, getToken]);

  const togglePushChannel = (id: string) => {
    if (id === "shopify" && !shopifyConnected) return;
    setPushChannels((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const handlePushToDrafts = async () => {
    if (!pushProductId || pushChannels.length === 0) return;
    setPushLoading(true);
    setPushMessage(null);
    try {
      const token = await getAuthToken(getToken);
      const res = await apiFetch(`/api/v1/products/${pushProductId}/push-drafts`, {
        method: "POST",
        token,
        body: JSON.stringify({ channels: pushChannels, as_draft: true }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || "Push failed");
      }
      setPushMessage({
        type: "success",
        text: "Pushed to drafts. Review on each platform (e.g. Shopify admin) and push live there.",
      });
    } catch (e) {
      setPushMessage({
        type: "error",
        text: e instanceof Error ? e.message : "Push to drafts failed",
      });
    } finally {
      setPushLoading(false);
    }
  };

  const connectShopify = () => {
    window.location.href = "/shopify/launch?return=stores-list";
  };

  if (!isLoaded) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "2rem", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div className="dashboard-loading-spinner" aria-hidden />
        <p style={{ marginTop: "1rem", color: "var(--muted)", fontSize: "0.875rem" }}>Loading Dashboard…</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header className="glass-nav" style={{ padding: "1rem 2rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Link href="/landing.html" style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text)" }}>
          SyncLyst
        </Link>
        <UserButton afterSignOutUrl="/landing.html" />
      </header>
      <main style={{ padding: "2rem", maxWidth: "64rem", margin: "0 auto" }}>
        <div style={{ marginBottom: "2rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text)", marginBottom: "0.25rem" }}>Dashboard</h1>
          <p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
            {user?.emailAddresses?.[0]?.emailAddress ?? "Dashboard"}
          </p>
          {usage !== null && (
            <p style={{ marginTop: "0.5rem", fontSize: "0.8125rem", color: "var(--muted)" }}>
              🔍 {usage.scans_used}/{usage.scans_limit} scans used · Plan: {usage.tier}
            </p>
          )}
          {billingNotice && (
            <div style={{ marginTop: "0.75rem", padding: "0.65rem 1rem", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", display: "inline-flex", alignItems: "center", gap: "0.75rem" }}>
              <span style={{ fontSize: "0.8125rem", color: "#166534", fontWeight: 500 }}>{billingNotice.text}</span>
              <button type="button" onClick={() => setBillingNotice(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#166534", fontSize: "1rem", lineHeight: 1, padding: 0 }} aria-label="Dismiss">×</button>
            </div>
          )}
          {usage?.can_scan && usage.scans_used === 0 && (
            <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", display: "inline-block" }}>
              <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "#166534" }}>✨ You’re ready to scan.</span>
            </div>
          )}
          {usage && !usage.can_scan && (
            <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", display: "inline-block" }}>
              <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "#991b1b" }}>You&apos;ve hit your scan limit.</span>
              <Link href="/landing.html#waitlist" style={{ display: "block", marginTop: "0.5rem", fontSize: "0.875rem", fontWeight: 600, color: "var(--accent)" }}>Join waitlist →</Link>
            </div>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "1.5rem" }}>
          {pushProductId && (
            <section className="glass-card" style={{ padding: "1.5rem", gridColumn: "1 / -1" }}>
              <h3 className="section-label">Push to drafts</h3>
              <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginBottom: "1rem" }}>
                Select the platforms you want to push this listing to as a draft. Then review on each platform and push live there.
              </p>
              <p style={{ fontWeight: 600, color: "var(--text)", marginBottom: "1rem" }}>
                &quot;{pushProductTitle ?? "…"}&quot;
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center", marginBottom: "1rem" }}>
                {MARKETPLACES.map((m) => {
                  const isShopify = m.id === "shopify";
                  const connected = isShopify && shopifyConnected;
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
              <button
                type="button"
                onClick={handlePushToDrafts}
                disabled={pushLoading || pushChannels.length === 0}
                className="glass-cta"
                style={{ padding: "0.5rem 1.25rem", borderRadius: "8px", fontWeight: 600, cursor: pushLoading || pushChannels.length === 0 ? "not-allowed" : "pointer", color: "#fff" }}
              >
                {pushLoading ? "Pushing…" : "Push to drafts"}
              </button>
            </section>
          )}
          <ApiKeyPanel />
          <section id="connect-marketplaces" className="glass-card" style={{ padding: "1.5rem", gridColumn: "1 / -1" }}>
            <h3 className="section-label">Connect your marketplaces</h3>
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
                    title={available ? (connected ? `Connected: ${shopifyShopDomain || "Shopify"}` : "Connect") : "Coming soon"}
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
                    Connected: {shopifyShopDomain || "Shopify"}. Add another store below.
                  </p>
                ) : null}
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "0.75rem" }}>
                  <button
                    type="button"
                    onClick={connectShopify}
                    className="glass-cta"
                    style={{ padding: "0.5rem 1rem", borderRadius: "8px", fontWeight: 600, cursor: "pointer", color: "#fff", width: "100%" }}
                  >
                    {shopifyConnected ? "Connect another store" : "Connect store"}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
