import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function cors(request: NextRequest): HeadersInit {
  const origin = request.headers.get("origin");
  if (origin?.startsWith("chrome-extension://")) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept",
    };
  }
  if (!origin) {
    return { "Access-Control-Allow-Origin": "*" };
  }
  return {};
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(request) });
}

/**
 * Public anon (publishable) key + project URL for phone/extension Realtime.
 * Accepts same names as Vercel often uses: SUPABASE_URL + publishable in NEXT_PUBLIC_*
 * or server-only SUPABASE_ANON_KEY (returned in JSON; still a public/anon key).
 */
export async function GET(request: NextRequest) {
  const h = cors(request);
  const url =
    (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").trim() || "";
  const anon =
    (
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      ""
    ).trim() || "";
  const configured = !!(url && anon);
  return NextResponse.json(
    {
      configured,
      supabaseUrl: configured ? url : null,
      supabaseAnonKey: configured ? anon : null,
    },
    { headers: h }
  );
}
