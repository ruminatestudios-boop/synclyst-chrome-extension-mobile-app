import { NextResponse } from "next/server";

/**
 * Shopify App URL must not go through Clerk’s auth handshake (no session yet).
 * Relying on `matcher` negative lookahead is unreliable with Next’s path matching on Vercel.
 */
// Keep this file free of TypeScript-only syntax.
// Vercel's post-build middleware packaging can choke on TS AST tokens (e.g. ColonToken),
// even though Next itself compiles TS fine.
export default function middleware(request: any) {
  const p = request.nextUrl.pathname;
  if (p === "/shopify/launch" || p === "/shopify/launch/") {
    return NextResponse.next();
  }
  // Extension companion page should be reachable without auth.
  if (p === "/extension-ui" || p === "/extension-ui/") {
    return NextResponse.next();
  }
  if (p === "/extension-return" || p === "/extension-return/") {
    return NextResponse.next();
  }
  // Shopify webhooks are sent server-to-server and must not be blocked by Clerk.
  if (p.startsWith("/api/shopify/webhooks/")) {
    return NextResponse.next();
  }
  /**
   * IMPORTANT: Middleware runs on the Edge runtime on Vercel.
   * Some Clerk server helpers pull in Node-only crypto deps, which can break builds.
   *
   * We rely on page-level Clerk guards (e.g. SignedIn/SignedOut) instead of Edge middleware.
   */
  return NextResponse.next();
}

export const config = {
  /**
   * Hard-disable middleware routing.
   *
   * We were seeing persistent `MIDDLEWARE_INVOCATION_FAILED` in production Edge runtime,
   * blocking `/snap` + `/api/snap-pair/*`. Disabling middleware fully removes the Edge hop.
   *
   * If/when we need middleware again, reintroduce it only after verifying Edge-safe deps.
   */
  matcher: [],
};
