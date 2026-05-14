import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  getPublishingJwtSecret,
  normalizeMyshopifyDomain,
  signPublishingJwt,
} from "@/lib/publishingJwt";

export const runtime = "nodejs";

/** Same default host as `next.config.ts` publishing proxy when running on Vercel. */
const defaultPublishingUrlOnVercel =
  "https://synclyst-publishing-299567386855.us-central1.run.app";

function publishingBaseUrl(): string {
  const u =
    process.env.PUBLISHING_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_PUBLISHING_API_URL?.trim() ||
    (process.env.VERCEL === "1" ? defaultPublishingUrlOnVercel : "");
  return u.replace(/\/$/, "");
}

/** Align `/connect-store?return=` keys with publishing `return_to` paths. */
function normalizeConnectReturnTo(raw: string | undefined | null): string {
  const r = (raw ?? "").trim();
  if (!r) return "dashboard/home";
  switch (r) {
    case "dashboard-home":
    case "dashboard/home":
      return "dashboard/home";
    case "review":
    case "flow-3":
    case "flow-3.html":
      return "review";
    case "flow-batch-review":
      return "flow-batch-review.html";
    case "stores-list":
      return "stores-list.html";
    case "flow-marketplaces":
      return "review";
    case "flow-connect":
      return "flow-connect-done.html";
    default:
      return r;
  }
}

function connectStoreReturnParam(returnTo: string): string | null {
  switch (returnTo) {
    case "dashboard/home":
      return "dashboard-home";
    case "review":
      return "review";
    case "flow-batch-review.html":
      return "flow-batch-review";
    case "stores-list.html":
      return "stores-list";
    case "flow-connect-done.html":
      return "flow-connect";
    case "flow-marketplaces":
      return "flow-marketplaces";
    default:
      return null;
  }
}

/**
 * Starts Shopify OAuth on the publishing API with a signed start_token (binds Clerk user → shop).
 * Use from connect UI: GET /api/shopify/oauth-start?shop=…&return_to=…
 * App Store "App URL" can point to /shopify/launch which forwards here.
 */
export async function GET(request: NextRequest) {
  const shopRaw = request.nextUrl.searchParams.get("shop")?.trim() || "";
  const returnRaw =
    request.nextUrl.searchParams.get("return_to")?.trim() ||
    request.nextUrl.searchParams.get("return")?.trim() ||
    "";
  const returnTo = normalizeConnectReturnTo(returnRaw || "dashboard/home");

  if (!shopRaw) {
    const connect = new URL("/connect-store", request.nextUrl.origin);
    const rawReturn = request.nextUrl.searchParams.get("return")?.trim();
    if (rawReturn) {
      connect.searchParams.set("return", rawReturn);
    } else {
      const ret = connectStoreReturnParam(returnTo);
      if (ret) connect.searchParams.set("return", ret);
    }
    return NextResponse.redirect(connect, 307);
  }

  const shopNorm = normalizeMyshopifyDomain(shopRaw);
  if (!shopNorm.endsWith(".myshopify.com")) {
    return NextResponse.json(
      { error: "Invalid shop", hint: "Use your-store or your-store.myshopify.com" },
      { status: 400 }
    );
  }

  let { userId } = await auth();
  if (!userId && process.env.NODE_ENV !== "production") {
    userId = "dev-local";
  }
  if (!userId) {
    const origin = request.nextUrl.origin;
    const resume = new URL("/api/shopify/oauth-start", origin);
    resume.searchParams.set("shop", shopNorm);
    resume.searchParams.set("return_to", returnTo);
    resume.searchParams.delete("return");
    // New merchants hit this path first; Sign-in + unknown email shows "Couldn't find your account".
    // Sign-up preserves the same redirect so OAuth runs after account creation.
    const signUp = new URL("/sign-up", origin);
    signUp.searchParams.set("redirect_url", resume.pathname + resume.search);
    return NextResponse.redirect(signUp);
  }

  const secret = getPublishingJwtSecret();
  if (!secret) {
    return NextResponse.json(
      { error: "Server misconfigured", hint: "Set PUBLISHING_JWT_SECRET" },
      { status: 500 }
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const startToken = signPublishingJwt(
    {
      sub: userId,
      userId,
      purpose: "shopify_oauth_start",
      shop: shopNorm,
      return_to: returnTo,
      iat: now,
      exp: now + 600,
    },
    secret
  );

  const pub = publishingBaseUrl();
  if (!pub) {
    return NextResponse.json(
      {
        error: "Publishing URL not configured",
        hint: "Set PUBLISHING_APP_URL or NEXT_PUBLIC_PUBLISHING_API_URL",
      },
      { status: 500 }
    );
  }

  const target = new URL(`${pub}/auth/shopify`);
  target.searchParams.set("shop", shopNorm);
  target.searchParams.set("start_token", startToken);
  target.searchParams.set("return_to", returnTo);

  return NextResponse.redirect(target.toString());
}
