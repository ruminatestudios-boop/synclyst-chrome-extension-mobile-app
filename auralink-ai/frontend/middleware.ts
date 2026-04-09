import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextFetchEvent } from "next/server";
import type { NextRequest } from "next/server";

const clerk = clerkMiddleware();

/**
 * Shopify App URL must not go through Clerk’s auth handshake (no session yet).
 * Relying on `matcher` negative lookahead is unreliable with Next’s path matching on Vercel.
 */
export default function middleware(request: NextRequest, event: NextFetchEvent) {
  const p = request.nextUrl.pathname;
  if (p === "/shopify/launch" || p === "/shopify/launch/") {
    return NextResponse.next();
  }
  // Shopify webhooks are sent server-to-server and must not be blocked by Clerk.
  if (p.startsWith("/api/shopify/webhooks/")) {
    return NextResponse.next();
  }
  return clerk(request, event);
}

export const config = {
  matcher: [
    // Same as before, without shopify/launch in the lookahead — we skip Clerk in code above.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpg|jpeg|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
