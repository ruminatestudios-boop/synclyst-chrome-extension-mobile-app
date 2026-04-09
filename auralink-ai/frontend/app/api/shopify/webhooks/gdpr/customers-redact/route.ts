import { NextRequest, NextResponse } from "next/server";
import { verifyShopifyJsonWebhook } from "@/lib/shopifyGdprRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const v = await verifyShopifyJsonWebhook(request);
  if (!v.ok) return v.response;
  return new NextResponse(null, { status: 200 });
}
