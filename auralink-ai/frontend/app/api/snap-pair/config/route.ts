import { NextRequest, NextResponse } from "next/server";
import { resolveSupabaseAnonKey, resolveSupabaseProjectUrl } from "@/lib/supabase-env";

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
 * Tries all common Vercel / Supabase env names so copy-paste from dashboards works.
 */
export async function GET(request: NextRequest) {
  const h = cors(request);
  const url = resolveSupabaseProjectUrl();
  const anon = resolveSupabaseAnonKey();
  const configured = !!(url && anon);
  return NextResponse.json(
    {
      configured,
      supabaseUrl: configured ? url : null,
      supabaseAnonKey: configured ? anon : null,
      /** Booleans only — which pieces exist at runtime (helps fix missing Vercel env). */
      envPresent: {
        supabaseUrl: !!url,
        supabaseAnon: !!anon,
      },
    },
    { headers: h }
  );
}
