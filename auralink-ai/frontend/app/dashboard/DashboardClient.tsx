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

const MARKETPLACES = [
  { id: "shopify", name: "Shopify", logo: "https://www.google.com/s2/favicons?domain=shopify.com&sz=128", connect: true },
  { id: "amazon", name: "Amazon", logo: "https://www.google.com/s2/favicons?domain=amazon.com&sz=128", connect: false },
  { id: "tiktok", name: "TikTok Shop", logo: "https://www.google.com/s2/favicons?domain=tiktok.com&sz=128", connect: false },
  { id: "ebay", name: "eBay", logo: "/assets/ebay-logo.png", connect: false },
  { id: "etsy", name: "Etsy", logo: "https://www.google.com/s2/favicons?domain=etsy.com&sz=128", connect: false },
  { id: "vinted", name: "Vinted", logo: "https://www.google.com/s2/favicons?domain=vinted.com&sz=128", connect: false },
] as const;

const CLERK_JWT_TEMPLATE = process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE?.trim();

type BillingTier = "starter" | "pro" | "growth" | "scale";

const PLANS: {
  id: BillingTier;
  name: string;
  price: string;
  scans: string;
  paid: boolean;
}[] = [
  { id: "starter", name: "Starter", price: "£0/mo", scans: "3 scans", paid: false },
  { id: "pro", name: "Pro", price: "£9/mo", scans: "100 scans", paid: true },
  { id: "growth", name: "Growth", price: "£29/mo", scans: "500 scans", paid: true },
  { id: "scale", name: "Scale", price: "£79/mo", scans: "Unlimited", paid: true },
];

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
  const [billingNotice, setBillingNotice] = useState<string | null>(null);
  const [shopifyConnected, setShopifyConnected] = useState(false);
  const [shopifyShopDomain, setShopifyShopDomain] = useState<string | null>(null);

  const [pricingOpen, setPricingOpen] = useState(false);
  const [pricingErr, setPricingErr] = useState<string | null>(null);
  const [pricingCanceled, setPricingCanceled] = useState(false);
  const [pricingPreselect, setPricingPreselect] = useState<BillingTier | "">("");
  const [checkoutLoadingTier, setCheckoutLoadingTier] = useState<BillingTier | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [scanLimitModalShown, setScanLimitModalShown] = useState(false);
  const [autoStartConsumed, setAutoStartConsumed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setPushProductId(params.get("push_product"));
  }, []);

  const getClerkTokenSafe = async () => {
    if (!getToken) return null;
    try {
      return await getToken(CLERK_JWT_TEMPLATE ? { template: CLERK_JWT_TEMPLATE } : undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (CLERK_JWT_TEMPLATE && /jwt template exists with name/i.test(msg)) {
        return await getToken();
      }
      return null;
    }
  };

  const fetchUsage = async () => {
    try {
      const token = await getClerkTokenSafe();
      const r = await apiFetch("/api/v1/usage", { token });
      setUsage(r.ok ? await r.json() : null);
    } catch {
      setUsage(null);
    }
  };

  useEffect(() => {
    if (!isLoaded) return;
    // Shopify connection is owned by the publishing service (not the backend API).
    // Fetch via same-origin proxy: /__synclyst_publishing/api/user/connected-stores
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
    fetchUsage();
  }, [isLoaded, getToken]);

  useEffect(() => {
    if (!isLoaded || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const billing = (params.get("billing") || "").toLowerCase();
    const sessionId = params.get("session_id") || "";
    if (billing !== "success" || !sessionId) return;

    (async () => {
      try {
        const token = await getClerkTokenSafe();
        const res = await apiFetch("/api/v1/billing/confirm", {
          method: "POST",
          token,
          body: JSON.stringify({ session_id: sessionId }),
        });
        if (res.ok) {
          const j = (await res.json().catch(() => null)) as { tier?: unknown } | null;
          const tier = typeof j?.tier === "string" ? j.tier : null;
          if (tier && typeof window !== "undefined") {
            try {
              window.localStorage.setItem("synclyst_tier", tier);
            } catch {
              /* ignore */
            }
          }
          await fetchUsage();
          setBillingNotice("Payment confirmed. Your plan is now active.");
          setPricingErr(null);
          setPricingCanceled(false);
          setPricingOpen(true);
        } else {
          setBillingNotice("Payment received. Plan sync is in progress.");
        }
      } catch {
        setBillingNotice("Payment received. Plan sync is in progress.");
      } finally {
        const cleaned = new URL(window.location.href);
        cleaned.searchParams.delete("billing");
        cleaned.searchParams.delete("session_id");
        window.history.replaceState({}, "", cleaned.toString());
      }
    })();
  }, [isLoaded, getToken]);

  useEffect(() => {
    if (!isLoaded || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const open = params.get("pricing") === "1" || params.get("upgrade") === "1";
    const canceled = params.get("canceled") === "1";
    const tier = (params.get("tier") || "").toLowerCase();
    const preselect = tier === "pro" || tier === "growth" || tier === "scale" ? (tier as BillingTier) : "";
    if (open || canceled) {
      setPricingOpen(true);
      setPricingCanceled(canceled);
      setPricingPreselect(preselect);
    }
  }, [isLoaded]);

  useEffect(() => {
    if (!isLoaded || typeof window === "undefined") return;
    if (!pricingOpen) return;
    if (autoStartConsumed) return;
    if (checkoutLoadingTier !== null || portalLoading) return;
    const params = new URLSearchParams(window.location.search);
    const autostart = params.get("autostart") === "1";
    if (!autostart) return;
    const tier = (params.get("tier") || "").toLowerCase();
    if (tier !== "pro" && tier !== "growth" && tier !== "scale") return;
    const current = String(usage?.tier || "starter").toLowerCase();
    if (current === tier) {
      setAutoStartConsumed(true);
      return;
    }
    setAutoStartConsumed(true);
    // Fire and forget; errors show inside the modal via pricingErr.
    void startCheckout(tier as Exclude<BillingTier, "starter">);
  }, [isLoaded, pricingOpen, autoStartConsumed, checkoutLoadingTier, portalLoading, usage?.tier]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!usage || usage.can_scan) return;
    if (scanLimitModalShown) return;
    setScanLimitModalShown(true);
    setPricingErr(null);
    setPricingCanceled(false);
    setPricingPreselect("");
    setPricingOpen(true);
  }, [isLoaded, usage, scanLimitModalShown]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const tier = (usage?.tier || "").trim();
    if (!tier) return;
    try {
      window.localStorage.setItem("synclyst_tier", tier);
    } catch {
      /* ignore */
    }
  }, [usage?.tier]);

  useEffect(() => {
    if (!pushProductId || !getToken) return;
    getClerkTokenSafe()
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
      const token = await getClerkTokenSafe();
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

  const openPricing = () => {
    setPricingErr(null);
    setPricingCanceled(false);
    setPricingPreselect("");
    setPricingOpen(true);
  };

  const startCheckout = async (tier: Exclude<BillingTier, "starter">) => {
    if (typeof window === "undefined") return;
    setPricingErr(null);
    setCheckoutLoadingTier(tier);
    try {
      const token = await getClerkTokenSafe();
      if (!token) {
        setPricingErr("Could not verify your session. Please reload and try again.");
        return;
      }
      const origin = window.location.origin;
      const successUrl = `${origin}/dashboard?billing=success&pricing=1&session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = `${origin}/dashboard?pricing=1&tier=${encodeURIComponent(tier)}&canceled=1`;
      const res = await apiFetch("/api/v1/billing/checkout-session", {
        method: "POST",
        token,
        body: JSON.stringify({ tier, success_url: successUrl, cancel_url: cancelUrl }),
      });
      if (!res.ok) {
        const text = await res.text();
        setPricingErr(text || `Could not start checkout (${res.status}).`);
        return;
      }
      const body = (await res.json().catch(() => null)) as { url?: unknown } | null;
      const url = typeof body?.url === "string" ? body.url : "";
      if (!url) {
        setPricingErr("Checkout did not return a payment URL. Check Stripe configuration.");
        return;
      }
      window.location.href = url;
    } catch (e) {
      setPricingErr(e instanceof Error ? e.message : "Checkout failed");
    } finally {
      setCheckoutLoadingTier(null);
    }
  };

  const openPortal = async () => {
    if (typeof window === "undefined") return;
    setPricingErr(null);
    setPortalLoading(true);
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ return_url: `${window.location.origin}/dashboard?pricing=1` }),
      });
      const body = (await res.json().catch(() => null)) as { url?: unknown; detail?: unknown; error?: unknown } | null;
      if (!res.ok) {
        const msg = typeof body?.detail === "string" ? body.detail : typeof body?.error === "string" ? body.error : "Could not open billing portal";
        setPricingErr(msg);
        return;
      }
      const url = typeof body?.url === "string" ? body.url : "";
      if (!url) {
        setPricingErr("No portal URL returned");
        return;
      }
      window.location.href = url;
    } catch (e) {
      setPricingErr(e instanceof Error ? e.message : "Could not open billing portal");
    } finally {
      setPortalLoading(false);
    }
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
            <p style={{ marginTop: "0.5rem", fontSize: "0.8125rem", color: "#166534" }}>
              {billingNotice}
            </p>
          )}
          {usage?.can_scan && usage.scans_used === 0 && (
            <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", display: "inline-block" }}>
              <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "#166534" }}>✨ You’re ready to scan.</span>
            </div>
          )}
          {usage && !usage.can_scan && (
            <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", display: "inline-block" }}>
              <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "#991b1b" }}>You&apos;ve hit your scan limit.</span>
              <button
                type="button"
                onClick={openPricing}
                style={{
                  display: "block",
                  marginTop: "0.5rem",
                  fontSize: "0.875rem",
                  fontWeight: 700,
                  color: "var(--accent)",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                }}
              >
                Upgrade now →
              </button>
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

      {pricingOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0, 0, 0, 0.42)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPricingOpen(false);
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "44rem",
              borderRadius: 22,
              background: "#fff",
              boxShadow: "0 20px 70px rgba(0,0,0,0.28)",
              border: "1px solid rgba(15,23,42,0.1)",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1rem 1.1rem", borderBottom: "1px solid #eef2f7" }}>
              <div>
                <div style={{ fontWeight: 800, letterSpacing: "-0.02em" }}>Plans &amp; billing</div>
                <div style={{ fontSize: "0.8125rem", color: "#64748b", marginTop: 2 }}>
                  {usage ? (
                    <>
                      {usage.scans_used}/{usage.scans_limit} scans used · Current plan: <strong style={{ color: "#0f172a" }}>{usage.tier}</strong>
                    </>
                  ) : (
                    "Loading usage…"
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPricingOpen(false)}
                aria-label="Close"
                style={{ border: "none", background: "transparent", fontSize: "1.25rem", lineHeight: 1, cursor: "pointer", color: "#64748b" }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: "1rem 1.1rem 1.1rem" }}>
              {pricingCanceled && (
                <div style={{ marginBottom: "0.85rem", padding: "0.7rem 0.85rem", borderRadius: 14, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: "0.875rem" }}>
                  Checkout canceled — pick a plan when you&apos;re ready.
                </div>
              )}
              {pricingErr && (
                <div style={{ marginBottom: "0.85rem", padding: "0.7rem 0.85rem", borderRadius: 14, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: "0.875rem", whiteSpace: "pre-wrap" }}>
                  {pricingErr}
                </div>
              )}
              {usage && !usage.can_scan && (
                <div style={{ marginBottom: "0.85rem", padding: "0.7rem 0.85rem", borderRadius: 14, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: "0.875rem" }}>
                  You&apos;ve hit your scan limit. Upgrade to continue scanning.
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.9rem" }}>
                <div style={{ fontSize: "0.8125rem", color: "#6b7280" }}>
                  Signed in as <strong style={{ color: "#0f172a" }}>{user?.primaryEmailAddress?.emailAddress}</strong>
                </div>
                <button
                  type="button"
                  onClick={openPortal}
                  disabled={portalLoading || checkoutLoadingTier !== null}
                  style={{
                    borderRadius: 12,
                    border: "1px solid #e5e7eb",
                    background: "#fff",
                    padding: "0.55rem 0.85rem",
                    fontWeight: 700,
                    fontSize: "0.8125rem",
                    cursor: portalLoading || checkoutLoadingTier !== null ? "not-allowed" : "pointer",
                    opacity: portalLoading || checkoutLoadingTier !== null ? 0.6 : 1,
                  }}
                >
                  {portalLoading ? "Opening billing…" : "Manage billing"}
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {PLANS.map((p) => {
                  const currentTier = (usage?.tier || "starter").toLowerCase();
                  const isCurrent = currentTier === p.id;
                  const isSelected = pricingPreselect === p.id;
                  const showOutline = isSelected && !isCurrent;
                  const disabled = checkoutLoadingTier !== null || portalLoading;
                  const canUpgrade = p.paid && !isCurrent;
                  return (
                    <div
                      key={p.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "0.85rem",
                        padding: "0.95rem 1rem",
                        borderRadius: 18,
                        border: showOutline ? "2px solid #0f172a" : "1px solid #e5e7eb",
                        background: "#fafafa",
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                          <div style={{ fontSize: "1.05rem", fontWeight: 850, letterSpacing: "-0.01em", color: "#0f172a" }}>{p.name}</div>
                          {isCurrent ? (
                            <span style={{ fontSize: "0.72rem", fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#16a34a" }}>
                              Current
                            </span>
                          ) : null}
                        </div>
                        <div style={{ marginTop: 2, color: "#6b7280", fontSize: "0.9rem" }}>
                          {p.price} · {p.scans}
                        </div>
                      </div>
                      <div style={{ flexShrink: 0, minWidth: 9 * 16, textAlign: "center" }}>
                        {p.id === "starter" ? (
                          <span style={{ fontSize: "0.8125rem", fontWeight: 700, color: "#6b7280" }}>{isCurrent ? "Included" : "Free"}</span>
                        ) : canUpgrade ? (
                          <button
                            type="button"
                            onClick={() => startCheckout(p.id as Exclude<BillingTier, "starter">)}
                            disabled={disabled}
                            style={{
                              appearance: "none",
                              border: "none",
                              background: "#111827",
                              color: "#fff",
                              borderRadius: 12,
                              padding: "0.75rem 1rem",
                              fontWeight: 750,
                              fontSize: "0.875rem",
                              cursor: disabled ? "not-allowed" : "pointer",
                              opacity: disabled ? 0.6 : 1,
                            }}
                          >
                            {checkoutLoadingTier === p.id ? "Redirecting…" : "Upgrade"}
                          </button>
                        ) : (
                          <span style={{ fontSize: "0.8125rem", fontWeight: 700, color: "#6b7280" }}>Current</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ marginTop: "1rem", textAlign: "center", color: "#9ca3af", fontSize: "0.75rem", lineHeight: 1.35 }}>
                Payments processed by Stripe. Plan updates immediately after checkout.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
