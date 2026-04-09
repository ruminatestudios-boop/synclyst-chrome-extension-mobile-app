import { NextRequest, NextResponse } from "next/server";
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

  // We don't store customer PII; acknowledge the request.
  return NextResponse.json({ ok: true }, { status: 200 });
}

