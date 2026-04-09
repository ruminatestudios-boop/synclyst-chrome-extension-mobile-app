import { NextRequest, NextResponse } from "next/server";
import { deleteShopifyPlatformTokens } from "@/lib/deleteShopifyPlatformTokens";
import {
  readShopifyWebhookHeaders,
  verifyShopifyWebhookHmac,
} from "@/lib/shopifyWebhook";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const { hmac } = readShopifyWebhookHeaders(request.headers);

  const ok = verifyShopifyWebhookHmac({ rawBody, hmacHeader: hmac });
  if (!ok) return new NextResponse("Unauthorized", { status: 401 });

  let payload: { shop_domain?: string };
  try {
    payload = JSON.parse(rawBody) as { shop_domain?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await deleteShopifyPlatformTokens(String(payload.shop_domain || ""));
  if (!result.ok) {
    return NextResponse.json({ error: "Redaction failed" }, { status: 500 });
  }

  return new NextResponse(null, { status: 200 });
}

