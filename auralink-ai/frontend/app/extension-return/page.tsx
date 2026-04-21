/* eslint-disable react/no-danger */
"use client";

import { useEffect, useState } from "react";

export default function ExtensionReturnPage() {
  const [msg, setMsg] = useState("You can close this tab and return to the SyncLyst extension popup.");

  useEffect(() => {
    const u = new URL(window.location.href);
    const checkout = (u.searchParams.get("checkout") || "").trim();
    const tier = (u.searchParams.get("tier") || "").trim().toLowerCase();
    const sessionId = (u.searchParams.get("session_id") || "").trim();
    const billing = (u.searchParams.get("billing") || "").trim().toLowerCase();

    // Start checkout from a first-party page (avoids extension cookie limitations).
    if (checkout === "1") {
      if (tier !== "pro" && tier !== "growth" && tier !== "scale") {
        setMsg("Invalid plan selected. You can close this tab and return to the extension popup.");
        return;
      }
      setMsg("Opening secure checkout…");
      fetch("/api/billing/checkout-direct", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify({
          tier,
          success_url: `${window.location.origin}/extension-return?billing=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${window.location.origin}/extension-return?canceled=1&tier=${encodeURIComponent(tier)}`,
        }),
      })
        .then(async (r) => {
          if (r.status === 401) {
            // Not signed in: go to Clerk sign-in, then return here and try again.
            const redirectUrl = `/extension-return?checkout=1&tier=${encodeURIComponent(tier)}`;
            window.location.href = `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`;
            return null;
          }
          const j = await r.json().catch(() => null);
          if (!r.ok) {
            const detail = j && typeof j.detail === "string" ? j.detail : "";
            throw new Error(detail || `checkout_error_${r.status}`);
          }
          return j;
        })
        .then((j: any) => {
          if (!j) return;
          const url = j && typeof j.url === "string" ? j.url : "";
          if (!url) throw new Error("missing_checkout_url");
          window.location.href = url;
        })
        .catch(() => {
          setMsg("Could not start checkout. Please close this tab and try again from the extension.");
        });
      return;
    }

    if (billing === "success" && sessionId) {
      setMsg("Confirming your plan… you can close this tab.");
      fetch("/api/billing/confirm-direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
        credentials: "include",
      })
        .then((r) => r.json().catch(() => null))
        .then((j: any) => {
          const tier = j && typeof j.tier === "string" ? j.tier : "";
          if (tier) {
            try {
              window.localStorage.setItem("synclyst_tier", tier);
            } catch {
              /* ignore */
            }
          }
          setMsg("Plan updated. You can close this tab and return to the extension popup.");
        })
        .catch(() => {
          setMsg("Payment received. You can close this tab and return to the extension popup.");
        });
    }

    // Try close a couple times (some browsers only allow after user gesture).
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      try {
        window.close();
      } catch {
        /* ignore */
      }
      if (n >= 4) window.clearInterval(id);
    }, 350);
    return () => window.clearInterval(id);
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        margin: 0,
        padding: "24px 20px",
        fontFamily: "system-ui, sans-serif",
        background: "#f8fafc",
        color: "#0f172a",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "1.125rem", margin: "0 0 8px" }}>Return to SyncLyst</h1>
      <p style={{ fontSize: "0.9rem", lineHeight: 1.5, margin: "0 0 14px", color: "#475569", maxWidth: 420 }}>
        {msg}
      </p>
      <p style={{ fontSize: "0.8125rem", color: "#64748b", margin: 0 }}>If this tab doesn’t close automatically, just close it.</p>
    </main>
  );
}

