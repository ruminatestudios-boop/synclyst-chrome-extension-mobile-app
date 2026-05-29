"use client";

import { useEffect, useState, useCallback } from "react";

interface ListingRow {
  session_id: string;
  title: string | null;
  description: string | null;
  price: string | number | null;
  image_url: string | null;
  listing_extra: {
    tags?: string[];
    condition?: string;
    category?: string;
    media?: { image_urls?: string[] };
  } | null;
  updated_at: string | null;
}

const PLATFORM_LABELS: Record<string, string> = {
  shopify: "Shopify",
  ebay: "eBay",
  etsy: "Etsy",
  amazon: "Amazon",
  depop: "Depop",
  vinted: "Vinted",
  shopee: "Shopee",
  tiktok: "TikTok Shop",
  facebook: "Facebook",
  instagram: "Instagram",
};

export default function ExtensionReviewPage() {
  const [sessionId, setSessionId] = useState<string>("");
  const [platform, setPlatform] = useState<string>("");
  const [listing, setListing] = useState<ListingRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [saved, setSaved] = useState(false);

  // Parse query params client-side
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = (params.get("s") || "").trim();
    const p = (params.get("platform") || "").trim().toLowerCase();
    setSessionId(s);
    setPlatform(p);
  }, []);

  // Fetch listing from API once sessionId is known
  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    fetch(`/api/snap-pair/review?s=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setListing(data.listing ?? null);
        }
      })
      .catch(() => setError("Failed to load listing. Please close this tab and try again."))
      .finally(() => setLoading(false));
  }, [sessionId]);

  // Send SYNCLYST_REVIEW_SAVED → snap-bridge.js → background.js
  const handleSave = useCallback(() => {
    try {
      window.postMessage(
        { source: "synclyst-extension-review", type: "SYNCLYST_REVIEW_SAVED", sessionId },
        window.location.origin
      );
    } catch {
      /* ignore */
    }
    setSaved(true);
  }, [sessionId]);

  const imageUrl = listing?.image_url || listing?.listing_extra?.media?.image_urls?.[0] || "";
  const tags: string[] = listing?.listing_extra?.tags ?? [];
  const platformLabel = PLATFORM_LABELS[platform] || platform || "your marketplace";

  return (
    <main style={styles.main}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.logo}>SyncLyst®</span>
        {platform && (
          <span style={styles.platformBadge}>{platformLabel}</span>
        )}
      </div>

      {loading && (
        <div style={styles.center}>
          <p style={styles.muted}>Loading listing…</p>
        </div>
      )}

      {!loading && error && (
        <div style={styles.center}>
          <p style={styles.errorText}>{error}</p>
        </div>
      )}

      {!loading && !error && !listing && (
        <div style={styles.center}>
          <p style={styles.muted}>No listing found for this session.</p>
        </div>
      )}

      {!loading && !error && listing && !saved && (
        <div style={styles.card}>
          {/* Product image */}
          {imageUrl && (
            <div style={styles.imageWrap}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt={listing.title || "Product"} style={styles.image} />
            </div>
          )}

          {/* Title */}
          <h1 style={styles.title}>{listing.title || "Untitled"}</h1>

          {/* Price */}
          {listing.price != null && String(listing.price).trim() !== "" && (
            <p style={styles.price}>£{listing.price}</p>
          )}

          {/* Description */}
          {listing.description && (
            <div style={styles.section}>
              <p style={styles.sectionLabel}>Description</p>
              <p style={styles.description}>{listing.description}</p>
            </div>
          )}

          {/* Tags */}
          {tags.length > 0 && (
            <div style={styles.section}>
              <p style={styles.sectionLabel}>Tags</p>
              <div style={styles.tagsWrap}>
                {tags.map((tag, i) => (
                  <span key={i} style={styles.tag}>{tag}</span>
                ))}
              </div>
            </div>
          )}

          {/* Save button */}
          <button onClick={handleSave} style={styles.saveBtn}>
            ✓ Looks good — Fill & Save on {platformLabel}
          </button>
          <p style={styles.hint}>
            This will notify your extension to auto-fill the listing. You can close this tab afterwards.
          </p>
        </div>
      )}

      {saved && (
        <div style={styles.center}>
          <div style={styles.successCard}>
            <p style={styles.successIcon}>✓</p>
            <h2 style={styles.successTitle}>Sent to extension!</h2>
            <p style={styles.muted}>
              Return to the SyncLyst extension popup and click <strong>Magic Fill</strong> to auto-fill on {platformLabel}.
            </p>
            <button onClick={() => window.close()} style={styles.closeBtn}>
              Close tab
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100vh",
    background: "#f8fafc",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: "#0f172a",
    padding: "0 0 48px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "16px 20px",
    borderBottom: "1px solid #e2e8f0",
    background: "#fff",
  },
  logo: {
    fontWeight: 700,
    fontSize: "1rem",
    color: "#7c3aed",
    letterSpacing: "-0.01em",
  },
  platformBadge: {
    fontSize: "0.75rem",
    fontWeight: 500,
    background: "#f1f5f9",
    color: "#475569",
    padding: "3px 10px",
    borderRadius: 999,
  },
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "60vh",
    padding: "24px 20px",
  },
  card: {
    maxWidth: 560,
    margin: "24px auto",
    padding: "0 20px",
  },
  imageWrap: {
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 20,
    background: "#e2e8f0",
    aspectRatio: "4/3",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  title: {
    fontSize: "1.25rem",
    fontWeight: 700,
    margin: "0 0 8px",
    lineHeight: 1.3,
  },
  price: {
    fontSize: "1.125rem",
    fontWeight: 600,
    color: "#16a34a",
    margin: "0 0 20px",
  },
  section: {
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    margin: "0 0 6px",
  },
  description: {
    fontSize: "0.9rem",
    lineHeight: 1.6,
    color: "#334155",
    margin: 0,
    whiteSpace: "pre-wrap",
  },
  tagsWrap: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
  },
  tag: {
    fontSize: "0.75rem",
    background: "#ede9fe",
    color: "#6d28d9",
    padding: "3px 10px",
    borderRadius: 999,
    fontWeight: 500,
  },
  saveBtn: {
    width: "100%",
    padding: "14px 20px",
    background: "#7c3aed",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontSize: "1rem",
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 8,
    marginBottom: 10,
  },
  hint: {
    fontSize: "0.8rem",
    color: "#94a3b8",
    textAlign: "center",
    margin: 0,
    lineHeight: 1.5,
  },
  successCard: {
    textAlign: "center",
    maxWidth: 360,
  },
  successIcon: {
    fontSize: "3rem",
    color: "#16a34a",
    margin: "0 0 8px",
  },
  successTitle: {
    fontSize: "1.25rem",
    fontWeight: 700,
    margin: "0 0 12px",
  },
  muted: {
    fontSize: "0.9rem",
    color: "#64748b",
    lineHeight: 1.6,
    margin: "0 0 20px",
  },
  closeBtn: {
    padding: "10px 24px",
    background: "#f1f5f9",
    color: "#334155",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    fontSize: "0.9rem",
    fontWeight: 500,
    cursor: "pointer",
  },
  errorText: {
    fontSize: "0.9rem",
    color: "#dc2626",
    textAlign: "center",
    lineHeight: 1.6,
  },
};
