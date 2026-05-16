/**
 * Vercel often uses AURALINK_BACKEND_URL; the client bundle only sees NEXT_PUBLIC_*.
 * Map backend URL into NEXT_PUBLIC_API_URL when the latter is unset (build time).
 */
const resolvedPublicApiUrl =
  (process.env.NEXT_PUBLIC_API_URL || "").trim() ||
  (process.env.AURALINK_BACKEND_URL || "").trim() ||
  "";

/**
 * Rewrite `/__synclyst_publishing/*` → this base URL (must be set for production Vercel builds).
 * If unset on Vercel, Next defaulted to 127.0.0.1:8001 and the proxy 404’d on synclyst.app.
 * Override with PUBLISHING_PROXY_TARGET in Vercel → Environment Variables (Production).
 */
const defaultPublishingProxyForVercel =
  "https://synclyst-publishing-299567386855.us-central1.run.app";
const publishingProxyTarget =
  (process.env.PUBLISHING_PROXY_TARGET || "").trim() ||
  (process.env.VERCEL === "1" ? defaultPublishingProxyForVercel : "") ||
  "http://127.0.0.1:8001";

/** Root `/` content: `demo` (default) or `landing` when you switch the main site back to marketing. */
const homepageDestination =
  (process.env.SYNCLYST_HOMEPAGE || "").trim().toLowerCase() === "landing"
    ? "/landing.html"
    : "/demo.html";

const listingFlowRewrites = [
  { source: "/dashboard/home", destination: "/dashboard-home.html" },
  { source: "/flow/choose-platform", destination: "/flow-choose-platform.html" },
  { source: "/listing/review", destination: "/flow-3.html" },
  { source: "/flow/publish", destination: "/flow-publishing.html" },
  { source: "/listing/published", destination: "/flow-success.html" },
  { source: "/flow/success", destination: "/flow-success.html" },
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(resolvedPublicApiUrl ? { env: { NEXT_PUBLIC_API_URL: resolvedPublicApiUrl } } : {}),
  async redirects() {
    return [
      { source: "/shopify/launch", destination: "/api/shopify/oauth-start", permanent: false },
      { source: "/shopify/launch/", destination: "/api/shopify/oauth-start", permanent: false },
      { source: "/flow-3.html", destination: "/review", permanent: false },
      {
        source: "/home.html",
        has: [{ type: "query", key: "mode", value: "scan" }],
        destination: "/scan",
        permanent: false,
      },
      { source: "/flow-2.html", destination: "/reading-product", permanent: false },
      { source: "/flow-2", destination: "/reading-product", permanent: false },
      { source: "/flow/processing", destination: "/reading-product", permanent: false },
      { source: "/stores-connect-shopify.html", destination: "/connect-store", permanent: false },
      { source: "/dashboard-home.html", destination: "/dashboard/home", permanent: false },
    ];
  },
  async rewrites() {
    const pubBase = String(publishingProxyTarget || "").replace(/\/$/, "");
    const apiBase = String(resolvedPublicApiUrl || "").replace(/\/$/, "");
    return {
      // beforeFiles: run before App Router / public checks so static `public/*.html` wins.
      // This avoids Vercel NOT_FOUND when the `/snap` App route is missing or not bundled.
      beforeFiles: [
        { source: "/", destination: homepageDestination },
        { source: "/demo", destination: "/demo.html" },
        { source: "/snap", destination: "/snap.html" },
        { source: "/snap/", destination: "/snap.html" },
        { source: "/extension-review", destination: "/extension-review.html" },
        { source: "/extension-review/", destination: "/extension-review.html" },
      ],
      afterFiles: [
        ...listingFlowRewrites,
        { source: "/scan", destination: "/home.html" },
        { source: "/list", destination: "/home.html" },
        { source: "/reseller-results", destination: "/reseller-results.html" },
        { source: "/reading-product", destination: "/flow-2.html" },
        { source: "/flow-3", destination: "/flow-3.html" },
        { source: "/flow-publishing", destination: "/flow-publishing.html" },
        { source: "/review", destination: "/flow-3.html" },
        { source: "/connect-store", destination: "/stores-connect-shopify.html" },
        // Backend API proxy (avoid CORS in the browser). Requires NEXT_PUBLIC_API_URL or AURALINK_BACKEND_URL at build time.
        ...(apiBase ? [{ source: "/api/v1/:path*", destination: `${apiBase}/api/v1/:path*` }] : []),
        {
          source: "/__synclyst_publishing/:path*",
          destination: `${pubBase}/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;

