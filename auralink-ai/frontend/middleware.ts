import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextFetchEvent } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Required for `auth()` in Route Handlers (e.g. `/api/billing/checkout-redirect`).
 * Without this, Clerk throws: auth() was called but Clerk can't detect clerkMiddleware().
 *
 * When Clerk env is incomplete (publishable + secret), pass through unchanged so
 * local HTML-only experiments work without a full `.env.local`.
 */
const clerkConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && process.env.CLERK_SECRET_KEY?.trim()
);

const clerk = clerkMiddleware();

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  if (!clerkConfigured) {
    return NextResponse.next();
  }
  const p = request.nextUrl.pathname;
  if (p === "/shopify/launch" || p === "/shopify/launch/") {
    return NextResponse.next();
  }
  if (p.startsWith("/api/shopify/webhooks/")) {
    return NextResponse.next();
  }
  return clerk(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
