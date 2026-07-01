"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";

export default function DashboardGuest() {
  const [shopifyConnected, setShopifyConnected] = useState(false);
  const [shopifyShopDomain, setShopifyShopDomain] = useState<string | null>(null);
  const [usage, setUsage] = useState<{
    free_scans_used: number;
    free_scans_limit: number;
    can_scan: boolean;
  } | null>(null);

  useEffect(() => {
    // Fetch Shopify connection status (for future use).
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
      })
      .catch(() => {
        setShopifyConnected(false);
        setShopifyShopDomain(null);
      });

    // Fetch usage.
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

  // Suppress unused-var warnings for state kept for future use.
  void shopifyConnected;
  void shopifyShopDomain;

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", color: "#18181b" }}>
      {/* Header */}
      <header
        className="glass-nav"
        style={{
          padding: "1rem 2rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <Link href="/landing.html" style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text)", textDecoration: "none" }}>
          SyncLyst
        </Link>
        <Link
          href="/sign-in"
          style={{ fontSize: "0.875rem", color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}
        >
          Sign in
        </Link>
      </header>

      <main style={{ padding: "2rem", maxWidth: "40rem", margin: "0 auto" }}>
        {/* Scan counter */}
        <p style={{ textAlign: "center", fontSize: "0.875rem", color: "var(--muted)", marginBottom: "1.75rem" }}>
          {usage !== null
            ? `${usage.free_scans_used} / ${usage.free_scans_limit} free scans used (lifetime trial)`
            : "Loading usage…"}
        </p>

        {/* Main CTA card */}
        <div
          className="glass-card"
          style={{
            padding: "2rem 1.75rem",
            textAlign: "center",
            marginBottom: "1.5rem",
          }}
        >
          <h1
            style={{
              fontSize: "1.5rem",
              fontWeight: 700,
              color: "var(--text)",
              marginBottom: "0.625rem",
              letterSpacing: "-0.02em",
            }}
          >
            Scan a product, get your listing copy
          </h1>
          <p
            style={{
              color: "var(--muted)",
              fontSize: "0.9375rem",
              marginBottom: "1.5rem",
              lineHeight: 1.6,
            }}
          >
            Upload a photo — we&apos;ll write the title, description, bullet points, and keywords.
            Copy and paste into any platform.
          </p>

          {usage?.can_scan === false ? (
            <div>
              <p
                style={{
                  fontSize: "0.9375rem",
                  color: "#991b1b",
                  fontWeight: 600,
                  marginBottom: "0.75rem",
                }}
              >
                You&apos;ve used all your free scans.
              </p>
              <Link
                href="/billing"
                style={{
                  display: "inline-block",
                  padding: "0.625rem 1.5rem",
                  background: "var(--accent)",
                  color: "var(--bg)",
                  borderRadius: "8px",
                  fontWeight: 700,
                  fontSize: "0.9375rem",
                  textDecoration: "none",
                }}
              >
                Upgrade for more →
              </Link>
            </div>
          ) : (
            <Link
              href="/dashboard/upload"
              className="glass-cta"
              style={{
                display: "inline-block",
                padding: "0.75rem 2rem",
                borderRadius: "8px",
                fontWeight: 700,
                fontSize: "1rem",
                textDecoration: "none",
                color: "#fff",
              }}
            >
              Scan a product →
            </Link>
          )}
        </div>

        {/* How it works */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "0",
            marginBottom: "1.5rem",
            flexWrap: "wrap",
          }}
        >
          {[
            { icon: "📸", label: "Upload photo" },
            { icon: "✨", label: "AI writes listing" },
            { icon: "📋", label: "Copy & paste anywhere" },
          ].map((step, i, arr) => (
            <div key={i} style={{ display: "flex", alignItems: "center" }}>
              <div
                style={{
                  textAlign: "center",
                  padding: "0.75rem 1.25rem",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "10px",
                  minWidth: "110px",
                }}
              >
                <div style={{ fontSize: "1.375rem", marginBottom: "0.3rem" }}>{step.icon}</div>
                <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text)" }}>{step.label}</div>
              </div>
              {i < arr.length - 1 && (
                <div style={{ padding: "0 0.5rem", color: "var(--muted)", fontSize: "1rem" }}>→</div>
              )}
            </div>
          ))}
        </div>

        {/* Coming soon note */}
        <p
          style={{
            textAlign: "center",
            fontSize: "0.8125rem",
            color: "var(--muted)",
            marginTop: "0.5rem",
          }}
        >
          One-click publishing to Shopify, eBay &amp; more coming soon.
        </p>
      </main>
    </div>
  );
}
