import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "SyncLyst® · Extension",
  description: "Chrome extension companion UI",
};

/**
 * Lightweight page loaded inside the extension popup iframe.
 * Keeps users on-brand; deep links go to the main dashboard and scan flow.
 */
export default function ExtensionUiPage() {
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
      }}
    >
      <h1 style={{ fontSize: "1.125rem", margin: "0 0 8px" }}>SyncLyst®</h1>
      <p style={{ fontSize: "0.875rem", lineHeight: 1.5, margin: "0 0 16px", color: "#475569" }}>
        You can close this tab and return to the <strong>SyncLyst extension popup</strong>.
      </p>
      <ul style={{ fontSize: "0.875rem", lineHeight: 1.6, margin: 0, paddingLeft: "1.25rem" }}>
        <li>
          Tip: reopen the popup → Settings → Payments to upgrade.
        </li>
        <li>
          <Link href="/scan" style={{ color: "#2563eb" }}>
            New scan
          </Link>
        </li>
      </ul>
    </main>
  );
}
