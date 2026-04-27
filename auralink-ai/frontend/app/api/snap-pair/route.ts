import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * There is no single handler at `/api/snap-pair` in normal use; child routes
 * live under this path. This avoids a confusing Next 404 for manual checks.
 */
export function GET() {
  return NextResponse.json({
    name: "snap-pair",
    message: "Use a subpath, e.g. /api/snap-pair/config",
    endpoints: [
      "GET  /api/snap-pair/config",
      "POST /api/snap-pair/push",
      "POST /api/snap-pair/session",
      "GET  /api/snap-pair/session/:id",
      "PUT  /api/snap-pair/session/:id/listing",
      "POST /api/snap-pair/upload-original",
    ],
  });
}
