"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

// Clerk paused for testing — no token passed; backend allows guest usage.
export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [savedProductId, setSavedProductId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWaitlistModal, setShowWaitlistModal] = useState(false);
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [waitlistSubmitting, setWaitlistSubmitting] = useState(false);
  const [waitlistStatus, setWaitlistStatus] = useState<{ type: "ok" | "err" | "warn"; text: string } | null>(null);
  /** Shown in modal; set from 402 JSON `scans_limit` (matches backend STARTER_SCAN_LIMIT). */
  const [waitlistScansLimit, setWaitlistScansLimit] = useState(3);
  const [buyLoading, setBuyLoading] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);

  const submitWaitlist = async () => {
    const email = waitlistEmail.trim();
    if (!email || !email.includes("@")) {
      setWaitlistStatus({ type: "err", text: "Enter a valid email." });
      return;
    }

    setWaitlistSubmitting(true);
    setWaitlistStatus({ type: "warn", text: "Adding you to waitlist..." });
    try {
      const res = await fetch("/__synclyst_publishing/auth/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source: "upload-scan-limit" }),
      });
      if (!res.ok) throw new Error("waitlist_failed");
      setWaitlistStatus({ type: "ok", text: "You are on the waitlist. We will email you when paid plans open." });
    } catch {
      setWaitlistStatus({ type: "err", text: "Could not join waitlist. Please try again." });
    } finally {
      setWaitlistSubmitting(false);
    }
  };

  const handleBuyScans = async () => {
    setBuyLoading(true);
    setBuyError(null);
    try {
      const anonId =
        (typeof window !== "undefined" && localStorage.getItem("synclyst_anon_id_v1")) || "";
      const res = await fetch("/api/v1/billing/guest-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anon_id: anonId }),
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => "Unknown error");
        throw new Error(msg || `Error ${res.status}`);
      }
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error("No checkout URL returned");
      }
    } catch (err) {
      setBuyError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuyLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buf).reduce((acc, byte) => acc + String.fromCharCode(byte), "")
      );
      const res = await apiFetch("/api/v1/vision/extract", {
        method: "POST",
        body: JSON.stringify({
          image_base64: base64,
          mime_type: file.type || "image/jpeg",
          include_ocr: true,
        }),
      });
      if (res.status === 402) {
        // Send user back to dashboard pricing modal (direct-to-Stripe upgrade).
        try {
          if (typeof window !== "undefined") {
            window.location.href = "/dashboard?pricing=1";
            return;
          }
        } catch {
          /* ignore */
        }
        setError("Scan limit reached. Open billing to upgrade.");
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setResult(data);
      setSavedProductId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "2rem" }}>
      <div style={{ marginBottom: "1.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Photo → Draft Listing</h2>
        <Link href="/dashboard" style={{ fontSize: "0.875rem", color: "var(--muted)" }}>← Dashboard</Link>
      </div>
      <p style={{ color: "var(--muted)", marginBottom: "1.5rem" }}>
        Upload a product image. Extraction runs in &lt;3s and returns attributes, copy, and tags.
      </p>
      <form onSubmit={handleSubmit}>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ marginBottom: "1rem", color: "var(--text)" }}
        />
        <button
          type="submit"
          disabled={!file || loading}
          style={{
            padding: "0.5rem 1rem",
            background: "var(--accent)",
            color: "var(--bg)",
            border: "none",
            borderRadius: "6px",
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Extracting…" : "Extract"}
        </button>
      </form>
      {error && <p style={{ color: "#f87171", marginTop: "1rem" }}>{error}</p>}
      {result && (
        <div style={{ marginTop: "1.5rem" }}>
          <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={async () => {
                try {
                  setError(null);
                  const res = await apiFetch("/api/v1/products/from-extraction", {
                    method: "POST",
                    body: JSON.stringify(result),
                  });
                  if (!res.ok) throw new Error(await res.text());
                  const { id } = await res.json();
                  setSavedProductId(id);
                  setError(null);
                  alert(`Draft saved! Product ID: ${id}`);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
              style={{
                padding: "0.5rem 1rem",
                background: "var(--accent)",
                color: "var(--bg)",
                border: "none",
                borderRadius: "6px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Save as draft
            </button>
            {savedProductId && (
              <Link
                href={`/dashboard?push_product=${savedProductId}`}
                style={{
                  padding: "0.5rem 1rem",
                  background: "var(--accent)",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                Push to marketplaces →
              </Link>
            )}
            {result && (
              <a
                href="/review"
                onClick={() => {
                  try {
                    window.sessionStorage.setItem("auralink_primary_channel", "shopify");
                    const ext = result as { extraction_copy?: unknown; attributes?: { price_value?: number } & Record<string, unknown>; tags?: unknown };
                    window.sessionStorage.setItem("auralink_draft_listing", JSON.stringify({
                      extraction: { copy: ext.extraction_copy, extraction_copy: ext.extraction_copy, attributes: ext.attributes, tags: ext.tags },
                      suggested_price: ext.attributes?.price_value,
                    }));
                  } catch (_) {}
                }}
                style={{
                  padding: "0.5rem 1rem",
                  border: "1px solid var(--accent)",
                  borderRadius: "6px",
                  fontWeight: 600,
                  textDecoration: "none",
                  color: "var(--accent)",
                }}
              >
                Confirm listing for Shopify →
              </a>
            )}
            <Link
              href="/dashboard/products"
              style={{
                padding: "0.5rem 1rem",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                fontWeight: 600,
                textDecoration: "none",
                color: "var(--text)",
              }}
            >
              View products
            </Link>
          </div>
          <pre style={{ padding: "1rem", background: "var(--surface)", borderRadius: "8px", overflow: "auto", fontSize: "0.875rem" }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
      {showWaitlistModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0, 0, 0, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowWaitlistModal(false);
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "28rem",
              background: "#fff",
              borderRadius: "12px",
              border: "1px solid var(--border)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
              padding: "1rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
              <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>Scan limit reached</h3>
              <button
                type="button"
                onClick={() => setShowWaitlistModal(false)}
                style={{ border: "none", background: "transparent", color: "var(--muted)", cursor: "pointer", fontSize: "1.25rem", lineHeight: 1 }}
                aria-label="Close waitlist modal"
              >
                ×
              </button>
            </div>
            <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginTop: 0, marginBottom: "0.75rem" }}>
              You&apos;ve used all {waitlistScansLimit} free scans today. Top up instantly — no subscription needed.
            </p>
            <button
              type="button"
              onClick={handleBuyScans}
              disabled={buyLoading}
              style={{
                width: "100%",
                marginBottom: "0.75rem",
                border: "none",
                background: "#2563eb",
                color: "#fff",
                borderRadius: "8px",
                padding: "0.7rem 0.9rem",
                fontWeight: 700,
                fontSize: "0.9375rem",
                cursor: buyLoading ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.5rem",
              }}
            >
              {buyLoading ? (
                <span style={{ display: "inline-block", width: "1em", height: "1em", border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
              ) : null}
              {buyLoading ? "Redirecting to checkout…" : "Get 20 extra scans — $1.99"}
            </button>
            {buyError && (
              <p style={{ marginTop: "-0.5rem", marginBottom: "0.5rem", fontSize: "0.75rem", color: "#991b1b" }}>
                {buyError}
              </p>
            )}
            <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.5rem", textAlign: "center" }}>— or get notified when subscription plans launch —</p>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type="email"
                value={waitlistEmail}
                onChange={(e) => setWaitlistEmail(e.target.value)}
                placeholder="you@company.com"
                style={{
                  flex: 1,
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  padding: "0.6rem 0.75rem",
                  fontSize: "0.875rem",
                }}
              />
              <button
                type="button"
                onClick={submitWaitlist}
                disabled={waitlistSubmitting}
                style={{
                  border: "1px solid #111",
                  background: "#111",
                  color: "#fff",
                  borderRadius: "8px",
                  padding: "0.6rem 0.9rem",
                  fontWeight: 600,
                  cursor: waitlistSubmitting ? "not-allowed" : "pointer",
                }}
              >
                {waitlistSubmitting ? "Joining..." : "Join waitlist"}
              </button>
            </div>
            {waitlistStatus && (
              <p
                style={{
                  marginTop: "0.65rem",
                  marginBottom: 0,
                  fontSize: "0.75rem",
                  color:
                    waitlistStatus.type === "ok"
                      ? "#166534"
                      : waitlistStatus.type === "warn"
                        ? "#92400e"
                        : "#991b1b",
                }}
              >
                {waitlistStatus.text}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
