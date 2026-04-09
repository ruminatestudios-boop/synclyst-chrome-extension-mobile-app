import { NextRequest, NextResponse } from "next/server";
import { deferUntil } from "@/lib/deferUntil";
import { deleteShopifyPlatformTokens } from "@/lib/deleteShopifyPlatformTokens";
import {
  readShopifyWebhookHeaders,
  verifyShopifyWebhookHmac,
} from "@/lib/shopifyWebhook";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBuf = Buffer.from(await request.arrayBuffer());
  const { hmac } = readShopifyWebhookHeaders(request.headers);

  const ok = verifyShopifyWebhookHmac({ rawBody: rawBuf, hmacHeader: hmac });
  if (!ok) return new NextResponse("Unauthorized", { status: 401 });

  let payload: { shop_domain?: string };
  try {
    payload = JSON.parse(rawBuf.toString("utf8")) as { shop_domain?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const shop = String(payload.shop_domain || "");
  deferUntil(
    deleteShopifyPlatformTokens(shop).then((result) => {
      if (!result.ok) console.error("[gdpr/shop-redact] delete failed", result.error);
    })
  );

  return new NextResponse(null, { status: 200 });
}

