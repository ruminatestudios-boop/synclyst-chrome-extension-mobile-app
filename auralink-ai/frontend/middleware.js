import { NextResponse } from "next/server";

export default function middleware(request) {
  const p = request.nextUrl.pathname;
  if (p === "/shopify/launch" || p === "/shopify/launch/") return NextResponse.next();
  if (p === "/extension-ui" || p === "/extension-ui/") return NextResponse.next();
  if (p === "/extension-return" || p === "/extension-return/") return NextResponse.next();
  if (p.startsWith("/api/shopify/webhooks/")) return NextResponse.next();
  return NextResponse.next();
}

export const config = {
  // Hard-disable middleware routing to avoid Edge crashes.
  matcher: [],
};

