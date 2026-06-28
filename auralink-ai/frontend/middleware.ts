import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Public routes — accessible without sign-in.
 * Everything else is left open too (we protect individual routes server-side),
 * but these are explicitly whitelisted so Clerk never 401s them.
 */
const isPublicRoute = createRouteMatcher([
  "/",
  "/landing(.*)",
  "/snap(.*)",
  "/scan(.*)",
  "/list(.*)",
  "/reading-product(.*)",
  "/review(.*)",
  "/flow(.*)",
  "/demo(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/sign-out(.*)",
  "/privacy(.*)",
  "/terms(.*)",
  "/developers",
  "/extension-return(.*)",
  "/extension-ui(.*)",
  "/extension-review(.*)",
  "/api/snap-pair(.*)",
  "/api/billing/webhook(.*)",
  // All static HTML files — no auth required
  "/(.*)\\.html",
]);

/**
 * Required for `auth()` in Route Handlers (e.g. `/api/billing/checkout-redirect`).
 * Without this, Clerk throws: auth() was called but Clerk can't detect clerkMiddleware().
 *
 * When no publishable key is set (local HTML-only experiments), pass through unchanged.
 */
const hasClerk =
  typeof process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY === "string" &&
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.trim().length > 0;

export default hasClerk
  ? clerkMiddleware(async (auth, request) => {
      if (!isPublicRoute(request)) {
        const { userId } = await auth();
        if (!userId) {
          // Redirect unauthenticated users to sign-in
          const signInUrl = new URL("/sign-in", request.url);
          signInUrl.searchParams.set("redirect_url", request.nextUrl.pathname);
          return NextResponse.redirect(signInUrl);
        }
      }
    })
  : function passthrough(_request: NextRequest) {
      return NextResponse.next();
    };

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
