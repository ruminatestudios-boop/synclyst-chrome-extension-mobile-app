"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

interface ExtractionResult {
  extraction_copy: {
    seo_title: string;
    description: string;
    bullet_points: string[];
    description_fact_feel_proof?: { fact?: string; feel?: string; proof?: string };
  };
  tags: {
    category?: string;
    search_keywords: string[];
  };
  attributes: {
    brand?: string;
    color?: string;
    material?: string;
    condition?: string;
    price_display?: string;
    price_value?: number;
  };
}

const copyBtnStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "6px",
  padding: "0.3rem 0.65rem",
  fontSize: "0.75rem",
  fontWeight: 600,
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      style={{
        ...copyBtnStyle,
        color: copied ? "#16a34a" : "var(--text)",
        borderColor: copied ? "#16a34a" : "var(--border)",
      }}
    >
      {copied ? "✓ Copied!" : label}
    </button>
  );
}

function buildCopyAll(result: ExtractionResult): string {
  const { extraction_copy, tags } = result;
  const bullets = extraction_copy.bullet_points.map((b) => `• ${b}`).join("\n");
  const keywords = tags.search_keywords.join(", ");
  const categoryLine = tags.category ? `\nCATEGORY: ${tags.category}` : "";
  return `TITLE:\n${extraction_copy.seo_title}\n\nDESCRIPTION:\n${extraction_copy.description}\n\nBULLET POINTS:\n${bullets}\n\nKEYWORDS:\n${keywords}${categoryLine}`;
}

function ResultsSection({ result }: { result: ExtractionResult }) {
  const [allCopied, setAllCopied] = useState(false);

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(buildCopyAll(result));
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const { extraction_copy, tags, attributes } = result;

  const detailParts: string[] = [];
  if (attributes.brand) detailParts.push(`Brand: ${attributes.brand}`);
  if (attributes.color) detailParts.push(`Color: ${attributes.color}`);
  if (attributes.condition) detailParts.push(`Condition: ${attributes.condition}`);
  if (attributes.price_display) detailParts.push(`Price: ${attributes.price_display}`);

  const cardStyle: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    padding: "1rem 1.125rem",
    marginBottom: "0.875rem",
  };

  const cardHeaderStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "0.5rem",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: "0.6875rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--muted)",
  };

  return (
    <div style={{ marginTop: "1.75rem" }}>
      {/* Copy all button */}
      <div style={{ marginBottom: "1.25rem" }}>
        <button
          type="button"
          onClick={handleCopyAll}
          style={{
            width: "100%",
            padding: "0.625rem 1rem",
            background: allCopied ? "#f0fdf4" : "var(--accent)",
            color: allCopied ? "#16a34a" : "var(--bg)",
            border: allCopied ? "1px solid #16a34a" : "none",
            borderRadius: "8px",
            fontWeight: 700,
            fontSize: "0.9375rem",
            cursor: "pointer",
          }}
        >
          {allCopied ? "✓ Copied to clipboard!" : "Copy all to clipboard"}
        </button>
      </div>

      {/* Title */}
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <span style={labelStyle}>Title</span>
          <CopyButton text={extraction_copy.seo_title} />
        </div>
        <p style={{ margin: 0, fontSize: "0.9375rem", color: "var(--text)", fontWeight: 600, lineHeight: 1.4 }}>
          {extraction_copy.seo_title}
        </p>
      </div>

      {/* Description */}
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <span style={labelStyle}>Description</span>
          <CopyButton text={extraction_copy.description} />
        </div>
        <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--text)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
          {extraction_copy.description}
        </p>
      </div>

      {/* Bullet points */}
      {extraction_copy.bullet_points.length > 0 && (
        <div style={cardStyle}>
          <div style={cardHeaderStyle}>
            <span style={labelStyle}>Bullet Points</span>
            <CopyButton
              text={extraction_copy.bullet_points.map((b) => `• ${b}`).join("\n")}
            />
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {extraction_copy.bullet_points.map((point, i) => (
              <li key={i} style={{ fontSize: "0.875rem", color: "var(--text)", lineHeight: 1.6, marginBottom: "0.25rem" }}>
                {point}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tags / Keywords */}
      {tags.search_keywords.length > 0 && (
        <div style={cardStyle}>
          <div style={cardHeaderStyle}>
            <span style={labelStyle}>Keywords</span>
            <CopyButton text={tags.search_keywords.join(", ")} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem", marginTop: "0.25rem" }}>
            {tags.search_keywords.map((kw, i) => (
              <span
                key={i}
                style={{
                  fontSize: "0.75rem",
                  padding: "0.2rem 0.55rem",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "20px",
                  color: "var(--text)",
                }}
              >
                {kw}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Category + Details row */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.875rem" }}>
        {tags.category && (
          <span
            style={{
              fontSize: "0.75rem",
              padding: "0.25rem 0.65rem",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              color: "var(--muted)",
              fontWeight: 600,
            }}
          >
            Category: {tags.category}
          </span>
        )}
        {detailParts.map((d, i) => (
          <span
            key={i}
            style={{
              fontSize: "0.75rem",
              padding: "0.25rem 0.65rem",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              color: "var(--muted)",
            }}
          >
            {d}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        if (typeof window !== "undefined") {
          window.location.href = "/dashboard?pricing=1";
          return;
        }
        setError("Scan limit reached. Open billing to upgrade.");
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setResult(data as ExtractionResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: "640px", margin: "0 auto", padding: "2rem" }}>
      {/* Header */}
      <div style={{ marginBottom: "1.25rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: "1.125rem", fontWeight: 700 }}>Scan product → get listing copy</h2>
        <Link href="/dashboard" style={{ fontSize: "0.875rem", color: "var(--muted)", textDecoration: "none" }}>
          ← Dashboard
        </Link>
      </div>

      {/* Banner */}
      <div
        style={{
          marginBottom: "1.5rem",
          padding: "0.625rem 0.875rem",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "8px",
          fontSize: "0.8125rem",
          color: "var(--muted)",
        }}
      >
        ✓ Copy your listing and paste it into Shopify, eBay, Etsy, or anywhere. One-click publishing coming soon.
      </div>

      {/* Upload form */}
      <form onSubmit={handleSubmit}>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ marginBottom: "1rem", color: "var(--text)", display: "block" }}
        />
        <button
          type="submit"
          disabled={!file || loading}
          style={{
            padding: "0.5rem 1.25rem",
            background: "var(--accent)",
            color: "var(--bg)",
            border: "none",
            borderRadius: "6px",
            fontWeight: 600,
            cursor: !file || loading ? "not-allowed" : "pointer",
            opacity: !file || loading ? 0.7 : 1,
          }}
        >
          {loading ? "Generating…" : "Generate listing"}
        </button>
      </form>

      {error && (
        <p style={{ color: "#f87171", marginTop: "1rem", fontSize: "0.875rem" }}>{error}</p>
      )}

      {result && <ResultsSection result={result} />}
    </div>
  );
}
