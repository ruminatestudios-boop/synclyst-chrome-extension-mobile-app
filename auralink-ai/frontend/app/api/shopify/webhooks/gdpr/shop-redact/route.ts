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
  if (!ok) return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });

  // Purge shop-related data/tokens (handled in publishing service); acknowledge here.
  return NextResponse.json({ ok: true }, { status: 200 });
}

