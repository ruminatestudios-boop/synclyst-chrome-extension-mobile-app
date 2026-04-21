import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";

export const runtime = "nodejs";

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const isExtension = origin.startsWith("chrome-extension://");
  if (!isExtension) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    vary: "origin",
  };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function GET(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ signedIn: false }, { status: 200, headers: corsHeaders(req) });
    }

    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const firstName = (user.firstName || "").trim();
    const lastName = (user.lastName || "").trim();
    const email = user.primaryEmailAddress?.emailAddress || "";
    const imageUrl = user.imageUrl || "";
    const externalAccounts = Array.isArray(user.externalAccounts)
      ? user.externalAccounts
      : [];
    const hasSocialAvatar = externalAccounts.some((account) => {
      const provider = String(account.provider || "").toLowerCase();
      return provider === "oauth_google" || provider === "oauth_facebook";
    });

    return NextResponse.json(
      {
        signedIn: true,
        firstName,
        lastName,
        email,
        imageUrl,
        hasSocialAvatar,
      },
      { headers: corsHeaders(req) }
    );
  } catch {
    return NextResponse.json({ signedIn: false }, { status: 200, headers: corsHeaders(req) });
  }
}

