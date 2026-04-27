import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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
  ? clerkMiddleware()
  : function passthrough(_request: NextRequest) {
      return NextResponse.next();
    };

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
