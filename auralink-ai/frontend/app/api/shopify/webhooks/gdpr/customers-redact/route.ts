import { NextRequest, NextResponse } from "next/server";
import {
  isShopifyWebhookSecretConfigured,
  readShopifyWebhookHeaders,
  verifyShopifyWebhookHmac,
} from "@/lib/shopifyWebhook";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isShopifyWebhookSecretConfigured()) {
    return new NextResponse("Webhook secret not configured", { status: 503 });
  }

  const rawBuf = Buffer.from(await request.arrayBuffer());
  const { hmac } = readShopifyWebhookHeaders(request.headers);

  const ok = verifyShopifyWebhookHmac({ rawBody: rawBuf, hmacHeader: hmac });
  if (!ok) return new NextResponse("Unauthorized", { status: 401 });

  // If any customer data was transiently processed, it is deleted on request.
  return NextResponse.json({ ok: true }, { status: 200 });
}

