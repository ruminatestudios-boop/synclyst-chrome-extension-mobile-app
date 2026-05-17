"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, useUser, useAuth } from "@clerk/nextjs";
import { Suspense, useState } from "react";

const PLANS: {
  id: "starter" | "pro" | "growth" | "scale";
  name: string;
  price: string;
  blurb: string;
  cta: string;
  paid: boolean;
}[] = [
  {
    id: "starter",
    name: "Starter",
    price: "£0/mo",
    blurb: "Try it free. No credit card needed.",
    cta: "Start for Free",
    paid: false,
  },
  {
    id: "pro",
    name: "Pro",
    price: "£9/mo",
    blurb: "For sellers just getting started on Shopify.",
    cta: "Upgrade now",
    paid: true,
  },
  {
    id: "growth",
    name: "Growth",
    price: "£29/mo",
    blurb: "For active sellers listing regularly.",
    cta: "Upgrade now",
    paid: true,
  },
  {
    id: "scale",
    name: "Scale",
    price: "£79/mo",
    blurb: "For high volume sellers and growing stores.",
    cta: "Upgrade now",
    paid: true,
  },
];

const CLERK_JWT_TEMPLATE = process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE?.trim();

function BillingInner() {
  const sp = useSearchParams();
  const canceled = sp?.get("canceled") === "1";
  const preselect = ((sp && sp.get("tier")) || "").toLowerCase();
  const { user } = useUser();
  const { getToken } = useAuth();
  const [loading, setLoading] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

  async function startCheckout(tier: "pro" | "growth" | "scale") {
    setErr(null);
    setLoading(tier);
    try {
      const token = await getToken(CLERK_JWT_TEMPLATE ? { template: CLERK_JWT_TEMPLATE } : undefined);
      if (!token) {
        setErr("Could not get auth token. Please sign in again.");
        setLoading(null);
        return;
      }
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const res = await fetch("/api/v1/billing/checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          tier,
          success_url: `${origin}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/billing?tier=${encodeURIComponent(tier)}&canceled=1`,
        }),
      });
      const data = (await res.json()) as { url?: string; error?: string; detail?: string; message?: string };
      if (!res.ok) {
        if (res.status === 503) {
          setErr("Payments are not yet configured. Please try again later.");
        } else if (res.status === 401 || res.status === 403) {
          setErr("Please sign in to upgrade.");
        } else if (res.status >= 500) {
          setErr("Payment service error. Please try again in a moment.");
        } else {
          setErr(data.detail || data.message || data.error || "Checkout failed. Please try again.");
        }
        setLoading(null);
        return;
      }
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setErr("No checkout URL returned. Please try again.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(null);
    }
  }

  async function openPortal() {
    setErr(null);
    setPortalLoading(true);
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { url?: string; error?: string; message?: string; detail?: string };
      if (!res.ok) {
        if (res.status === 404 || data.error === "no_subscription") {
          setErr("No active subscription found. Subscribe to a plan to manage billing.");
        } else if (res.status === 401) {
          setErr("Please sign in to manage billing.");
        } else if (res.status >= 500) {
          setErr("Billing service unavailable. Please try again in a moment.");
        } else {
          setErr(data.message || data.detail || data.error || "Could not open billing portal. Please try again.");
        }
        return;
      }
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setErr("No portal URL returned. Please contact support.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setPortalLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#fafafa", fontFamily: "Inter, system-ui, sans-serif" }}>
      <header
        style={{
          padding: "1rem 1.5rem",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "#fff",
        }}
      >
        <Link href="/landing.html" style={{ fontWeight: 700, color: "#111", textDecoration: "none" }}>
          SyncLyst<sup style={{ fontSize: "0.6em" }}>®</sup>
        </Link>
        <Link href="/dashboard" style={{ fontSize: "0.875rem", color: "#6b7280" }}>
          ← Dashboard
        </Link>
      </header>

      <main style={{ maxWidth: 960, margin: "0 auto", padding: "2rem 1rem 4rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "#111", marginBottom: "0.35rem" }}>Plans & billing</h1>
        <p style={{ color: "#6b7280", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
          Same credits model as our marketing site. Sign in to upgrade; Starter stays free.
        </p>

        {canceled && (
          <p style={{ padding: "0.75rem 1rem", background: "#fef3c7", color: "#92400e", borderRadius: 10, marginBottom: "1rem", fontSize: "0.875rem" }}>
            Checkout canceled — pick a plan when you&apos;re ready.
          </p>
        )}
        {err && (
          <p style={{ padding: "0.75rem 1rem", background: "#fef2f2", color: "#991b1b", borderRadius: 10, marginBottom: "1rem", fontSize: "0.875rem" }}>
            {err}
          </p>
        )}

        <SignedOut>
          <div style={{ padding: "1.5rem", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, marginBottom: "1.5rem" }}>
            <p style={{ margin: "0 0 1rem", color: "#374151" }}>Sign in to subscribe to a paid plan.</p>
            <SignInButton mode="modal">
              <button
                type="button"
                style={{
                  padding: "0.65rem 1.25rem",
                  background: "#111827",
                  color: "#fff",
                  border: "none",
                  borderRadius: 10,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Sign in
              </button>
            </SignInButton>
          </div>
        </SignedOut>

        <SignedIn>
          <p style={{ fontSize: "0.8125rem", color: "#6b7280", marginBottom: "1rem" }}>
            Signed in as <strong style={{ color: "#111" }}>{user?.primaryEmailAddress?.emailAddress}</strong>
          </p>
          <div style={{ marginBottom: "1.25rem", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={openPortal}
              disabled={portalLoading || loading !== null}
              style={{
                padding: "0.55rem 0.9rem",
                borderRadius: 10,
                fontWeight: 600,
                fontSize: "0.8125rem",
                border: "1px solid #e5e7eb",
                background: "#fff",
                color: "#111",
                cursor: portalLoading ? "wait" : "pointer",
              }}
            >
              {portalLoading ? "Opening billing…" : "Manage billing"}
            </button>
          </div>
        </SignedIn>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "1rem",
          }}
        >
          {PLANS.map((p) => {
            const highlight = p.id === "growth";
            const selected = preselect === p.id;
            return (
              <div
                key={p.id}
                style={{
                  border: selected ? "2px solid #5d56e1" : highlight ? "2px solid #111" : "1px solid #e5e7eb",
                  borderRadius: 14,
                  padding: "1.25rem",
                  background: "#fff",
                  boxShadow: "0 1px 3px rgba(0,0,0,.06)",
                  position: "relative",
                  opacity: p.id === "starter" ? 0.95 : 1,
                }}
              >
                {highlight && (
                  <span
                    style={{
                      position: "absolute",
                      top: -10,
                      left: "50%",
                      transform: "translateX(-50%)",
                      fontSize: "0.65rem",
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      background: "#111",
                      color: "#fff",
                      padding: "0.2rem 0.5rem",
                      borderRadius: 6,
                    }}
                  >
                    MOST POPULAR
                  </span>
                )}
                <h2 style={{ fontSize: "1.125rem", fontWeight: 700, margin: "0 0 0.25rem", color: "#111" }}>{p.name}</h2>
                <p style={{ fontSize: "1.5rem", fontWeight: 700, margin: "0 0 0.35rem", color: "#111" }}>{p.price}</p>
                <p style={{ fontSize: "0.8125rem", color: "#6b7280", margin: "0 0 1rem", minHeight: 40 }}>{p.blurb}</p>

                {p.paid ? (
                  <SignedIn>
                    <button
                      type="button"
                      disabled={loading !== null}
                      onClick={() => {
                        if (p.id === "pro" || p.id === "growth" || p.id === "scale") startCheckout(p.id);
                      }}
                      style={{
                        width: "100%",
                        padding: "0.65rem",
                        borderRadius: 10,
                        fontWeight: 600,
                        fontSize: "0.875rem",
                        border: highlight ? "none" : "1px solid #e5e7eb",
                        background: highlight ? "#111" : "#fff",
                        color: highlight ? "#fff" : "#111",
                        cursor: loading ? "wait" : "pointer",
                      }}
                    >
                      {loading === p.id ? "Redirecting…" : p.cta}
                    </button>
                  </SignedIn>
                ) : (
                  <Link
                    href="/sign-up?redirect_url=/dashboard/home"
                    style={{
                      display: "block",
                      textAlign: "center",
                      width: "100%",
                      padding: "0.65rem",
                      borderRadius: 10,
                      fontWeight: 600,
                      fontSize: "0.875rem",
                      border: "1px solid #e5e7eb",
                      background: "#fff",
                      color: "#111",
                      textDecoration: "none",
                    }}
                  >
                    {p.cta}
                  </Link>
                )}
                {p.paid && (
                  <SignedOut>
                    <SignInButton mode="modal">
                      <button
                        type="button"
                        style={{
                          width: "100%",
                          padding: "0.65rem",
                          borderRadius: 10,
                          fontWeight: 600,
                          fontSize: "0.875rem",
                          border: "1px solid #e5e7eb",
                          background: "#f9fafb",
                          color: "#6b7280",
                          cursor: "pointer",
                        }}
                      >
                        Sign in to upgrade
                      </button>
                    </SignInButton>
                  </SignedOut>
                )}
              </div>
            );
          })}
        </div>

        <p style={{ marginTop: "2rem", fontSize: "0.75rem", color: "#9ca3af", textAlign: "center" }}>
          Scans / month: Starter 3 · Pro 100 · Growth 500 · Scale unlimited (fair use). Payments processed by Stripe.
        </p>
      </main>
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div style={{ padding: "2rem", fontFamily: "system-ui" }}>Loading…</div>}>
      <BillingInner />
    </Suspense>
  );
}
