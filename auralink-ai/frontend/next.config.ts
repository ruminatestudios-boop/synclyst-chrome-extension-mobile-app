import type { NextConfig } from "next";
import path from "path";

/**
 * Vercel often uses AURALINK_BACKEND_URL; the client bundle only sees NEXT_PUBLIC_*.
 * Map backend URL into NEXT_PUBLIC_API_URL when the latter is unset (build time).
 */
const resolvedPublicApiUrl =
  process.env.NEXT_PUBLIC_API_URL?.trim() ||
  process.env.AURALINK_BACKEND_URL?.trim() ||
  "";

/**
 * Rewrite `/__synclyst_publishing/*` → this base URL (must be set for production Vercel builds).
 * If unset on Vercel, Next defaulted to 127.0.0.1:8001 and the proxy 404’d on synclyst.app.
 * Override with PUBLISHING_PROXY_TARGET in Vercel → Environment Variables (Production).
 */
const defaultPublishingProxyForVercel =
  "https://synclyst-publishing-299567386855.us-central1.run.app";
const publishingProxyTarget =
  process.env.PUBLISHING_PROXY_TARGET?.trim() ||
  (process.env.VERCEL === "1" ? defaultPublishingProxyForVercel : "") ||
  "http://127.0.0.1:8001";

/** Root `/` content: `demo` (default) or `landing` when you switch the main site back to marketing. */
const homepageDestination =
  process.env.SYNCLYST_HOMEPAGE?.trim().toLowerCase() === "landing"
    ? "/landing.html"
    : "/demo.html";

/**
 * Homepage: `/` rewrites to `homepageDestination` (demo.html by default; set SYNCLYST_HOMEPAGE=landing to switch).
 * `/landing.html` stays the full marketing page at a stable URL.
 *
 * Listing flow — typical user order (single-item, scan path):
 * 1. `/` — demo (default) or marketing if SYNCLYST_HOMEPAGE=landing; `/landing.html` — full marketing; CTA → /scan
 * 2. /scan (aliases: /home.html?mode=scan, /landing.html?mode=scan → redirect) — camera/upload → extraction → continue
 * 3. /reading-product (aliases: /flow-2.html, /flow-2, /flow/processing → redirect) — “Reading your product” / progress
 * 4. /review (aliases: /listing/review; file: flow-3.html) — edit listing, publish; /flow-3.html redirects to /review
 * 5. /listing/published (aliases: /flow/success, /flow-success.html) — final “you’re live” screen
 * — Static hub (public HTML): /dashboard/home (was dashboard-home.html; Next /dashboard stays Clerk app)
 * — Connect Shopify: /connect-store (aliases: /stores-connect-shopify.html → redirect)
 *
 * Platform pick (Etsy/eBay/TikTok/Shopify) often uses /flow-choose-platform.html before step 3
 * or when switching; batch flow uses /flow-batch*.html → review still lands on flow-3?batch=1.
 */
const listingFlowRewrites = [
  /** Static “home” dashboard (listings hub); URL bar stays /dashboard/home */
  { source: "/dashboard/home", destination: "/dashboard-home.html" },
  { source: "/flow/choose-platform", destination: "/flow-choose-platform.html" },
  { source: "/listing/review", destination: "/flow-3.html" },
  { source: "/flow/publish", destination: "/flow-publishing.html" },
  /** Canonical slug for the final success step (maps to public/flow-success.html). */
  { source: "/listing/published", destination: "/flow-success.html" },
  { source: "/flow/success", destination: "/flow-success.html" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname),
  ...(resolvedPublicApiUrl
    ? { env: { NEXT_PUBLIC_API_URL: resolvedPublicApiUrl } }
    : {}),
  async redirects() {
    return [
      /**
       * Shopify App URL → OAuth start (307). Fallback if Route Handler in app/shopify/launch
       * is not matched; query string preserved for relative destination.
       */
      { source: "/shopify/launch", destination: "/api/shopify/oauth-start", permanent: false },
      { source: "/shopify/launch/", destination: "/api/shopify/oauth-start", permanent: false },
      /** Prefer semantic URL in the address bar (query string preserved). */
      { source: "/flow-3.html", destination: "/review", permanent: false },
      /** Canonical scan URL: /home.html?mode=scan → /scan (home.html). /landing.html?mode=scan stays on landing (scan + publish CTA). */
      {
        source: "/home.html",
        has: [{ type: "query", key: "mode", value: "scan" }],
        destination: "/scan",
        permanent: false,
      },
      /** Canonical “Reading your product” step (was /flow-2.html, /flow-2, /flow/processing). */
      { source: "/flow-2.html", destination: "/reading-product", permanent: false },
      { source: "/flow-2", destination: "/reading-product", permanent: false },
      { source: "/flow/processing", destination: "/reading-product", permanent: false },
      /** Canonical Shopify connect page (was stores-connect-shopify.html). */
      {
        source: "/stores-connect-shopify.html",
        destination: "/connect-store",
        permanent: false,
      },
      /** Clean slug for static dashboard hub (Next app still uses /dashboard for Clerk). */
      {
        source: "/dashboard-home.html",
        destination: "/dashboard/home",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    const pubBase = publishingProxyTarget.replace(/\/$/, "");
    return {
      beforeFiles: [
        /** Main site root: demo by default; override with SYNCLYST_HOMEPAGE=landing (URL bar stays `/`). */
        { source: "/", destination: homepageDestination },
        /** Same demo at `/demo` (bookmark/share); `?mode=scan` opens scan. */
        { source: "/demo", destination: "/demo.html" },
      ],
      afterFiles: [
        /**
         * Phone pairing + extension review screens are static HTML in `public/`.
         * Keep clean URLs (`/snap`, `/extension-review`) working even when the App Router
         * pages / route handlers are not deployed yet (common when prod is behind local work).
         */
        { source: "/snap", destination: "/snap.html" },
        { source: "/extension-review", destination: "/extension-review.html" },
        ...listingFlowRewrites,
        /** Product scan (public/home.html); URL bar stays /scan */
        { source: "/scan", destination: "/home.html" },
        /** “Reading your product” (public/flow-2.html); URL bar stays /reading-product */
        { source: "/reading-product", destination: "/flow-2.html" },
        { source: "/flow-3", destination: "/flow-3.html" },
        { source: "/flow-publishing", destination: "/flow-publishing.html" },
        { source: "/review", destination: "/flow-3.html" },
        /** Shopify OAuth entry (public/stores-connect-shopify.html); URL bar stays /connect-store */
        { source: "/connect-store", destination: "/stores-connect-shopify.html" },
        // Same-origin proxy so flow-3 on :3000 can reach publishing without CORS / mixed-origin quirks
        {
          source: "/__synclyst_publishing/:path*",
          destination: `${pubBase}/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;
