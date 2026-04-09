import { NextRequest, NextResponse } from "next/server";
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

  // If any customer data was transiently processed, it is deleted on request.
  return NextResponse.json({ ok: true }, { status: 200 });
}

