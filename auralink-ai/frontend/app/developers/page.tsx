import Link from "next/link";
import DeveloperShell from "./DeveloperShell";
import styles from "./developers.module.css";

export const metadata = {
  title: "Developer API – Synclyst",
  description: "Synclyst public API documentation for product extraction and market intelligence.",
};

export default function DevelopersPage() {
  const base = process.env.NEXT_PUBLIC_API_URL || "https://auralink-api-299567386855.us-central1.run.app";

  return (
    <DeveloperShell wide active="docs">
      <div className={`${styles.card} ${styles.docsProse}`} style={{ marginBottom: 0 }}>
        <span className={styles.eyebrow}>Public API</span>
        <h1>Developer API</h1>
        <p>
          The Synclyst API turns product photos into listing-ready data. Every scan feeds our anonymised{" "}
          <strong>market intelligence</strong> dataset — after enough similar items, responses include real sold-price
          signals, not just AI guesses.
        </p>

        <div className={styles.ctaPanel}>
          <p className={styles.ctaPanelTitle}>Get started in 2 minutes</p>
          <ol className={styles.ctaPanelList}>
            <li>
              <Link href="/developers/dashboard">Open the dashboard</Link> and create an API key
            </li>
            <li>
              Call endpoints with{" "}
              <code>Authorization: Bearer sk_live_…</code>
            </li>
          </ol>
          <Link href="/developers/dashboard" className={styles.btnPrimary}>
            Go to API dashboard →
          </Link>
        </div>

        <h2>Authentication</h2>
        <p>
          Developer keys use the <code>sk_live_</code> prefix. Never expose keys in client-side browser code — call the
          API from your server or Zapier.
        </p>

        <h2>Base URL</h2>
        <p>
          <code>{base}</code> — also available at <code>/api/v1/public/*</code>
        </p>

        <h2>Endpoints</h2>
        <h3>POST /v1/extract</h3>
        <p>
          Full product extraction. Body: <code>image_base64</code> or <code>image_url</code>, <code>mime_type</code>,
          optional <code>use_case</code> (reseller, real_estate, insurance, pawnbroker, invoice, restaurant, generic).
        </p>
        <pre>
          <code>{`curl -X POST ${base}/v1/extract \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"image_url":"https://example.com/product.jpg","use_case":"reseller"}'`}</code>
        </pre>
        <p>Response includes <code>scan_id</code>, extraction fields, and <code>market_intelligence</code>.</p>

        <h3>POST /v1/classify</h3>
        <p>Category, brand, and condition only (skips web enrichment). Cheaper per call.</p>

        <h3>POST /v1/value</h3>
        <p>Price estimate from sold data when available; AI fallback otherwise.</p>

        <h3>GET /v1/market-value</h3>
        <p>
          Query: <code>category</code>, <code>brand</code>, optional <code>condition</code>, <code>platform</code>.
        </p>

        <h3>GET /v1/trending</h3>
        <p>Categories with rising scan volume vs the prior period.</p>

        <h3>PATCH /v1/scan/{"{scan_id}"}/outcome</h3>
        <p>Report listing outcome to improve market intelligence.</p>

        <h2>Rate limits</h2>
        <ul>
          <li>60 requests per minute per API key (burst)</li>
          <li>Monthly quota by plan (see dashboard)</li>
          <li>HTTP 429 when exceeded</li>
        </ul>

        <h2>Pricing (API plans)</h2>
        <table>
          <thead>
            <tr>
              <th>Plan</th>
              <th>Monthly calls</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Free</td>
              <td>50</td>
              <td>£0</td>
            </tr>
            <tr>
              <td>Starter</td>
              <td>10,000</td>
              <td>£99/mo</td>
            </tr>
            <tr>
              <td>Pro</td>
              <td>50,000</td>
              <td>£299/mo</td>
            </tr>
            <tr>
              <td>Enterprise</td>
              <td>Custom</td>
              <td>
                <a href="mailto:synclyst@gmail.com">Contact us</a>
              </td>
            </tr>
          </tbody>
        </table>
        <p style={{ fontSize: "0.875rem", color: "#6b7280" }}>
          Upgrade in the{" "}
          <Link href="/developers/dashboard" style={{ fontWeight: 600, color: "#111827" }}>
            dashboard
          </Link>
          . Per-call metered rates by use_case from £0.05–£0.25.
        </p>

        <h2>Legacy routes</h2>
        <p>
          <code>POST /api/v1/vision/extract</code> remains for the web app. New integrations should use{" "}
          <code>/v1/extract</code>.
        </p>
      </div>
    </DeveloperShell>
  );
}
