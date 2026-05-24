import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

// Returns a Clerk JWT for the signed-in user so static HTML flows can call protected APIs.
export async function GET() {
  try {
    const { userId, getToken } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const template = process.env.CLERK_JWT_TEMPLATE?.trim();

    let token: string | null = null;

    // Try the named template first; fall back to the default Clerk JWT if the
    // template doesn't exist in the Clerk dashboard (avoids a 500 in production).
    if (template) {
      try {
        token = await getToken({ template });
      } catch {
        // Template not found or misconfigured — fall through to default token
      }
    }

    // Fall back to the standard Clerk session token (no template)
    if (!token) {
      token = await getToken();
    }

    if (!token) return NextResponse.json({ error: "Missing token" }, { status: 401 });
    return NextResponse.json({ token });
  } catch (err) {
    console.error("[/api/clerk/token] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

