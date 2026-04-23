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

/** Public anon key + URL for extension Realtime (safe to expose with RLS). */
export async function GET(request: NextRequest) {
  const h = cors(request);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || "";
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
