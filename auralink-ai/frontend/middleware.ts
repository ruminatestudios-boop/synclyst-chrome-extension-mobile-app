import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Shopify App URL must not go through Clerk’s auth handshake (no session yet).
 * Relying on `matcher` negative lookahead is unreliable with Next’s path matching on Vercel.
 */
export default function middleware(request: NextRequest) {
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
  matcher: [
    // Same as before, without shopify/launch in the lookahead — we skip Clerk in code above.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpg|jpeg|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
