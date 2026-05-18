#!/usr/bin/env bash
# Packages the Chrome MV3 extension and optionally verifies the Next.js app build.
#
# Note: A full `next build` with `output: "export"` is not compatible with this
# project while App Router API routes (e.g. /api/get-latest-scan) exist. The
# extension popup loads https://synclyst.app via the iframe; deploy the Next app
# to Vercel (or similar) for those routes. Use this script to copy the
# extension folder for "Load unpacked" in Chrome.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/dist/synclyst-chrome-extension"
rm -rf "$OUT"
mkdir -p "$OUT"
# Generate manifest before packaging.
# - Default: store-ready (no <all_urls>, no localhost)
# - Dev: MANIFEST_MODE=dev (includes localhost)
MANIFEST_MODE="${MANIFEST_MODE:-prod}"
if [[ "$MANIFEST_MODE" == "dev" ]]; then
  node "${ROOT}/extension/build-manifest.mjs" --dev
else
  node "${ROOT}/extension/build-manifest.mjs"
  node "${ROOT}/extension/verify-store-manifest.mjs"
fi
cp -R "${ROOT}/extension/." "$OUT/"
echo "Packaged extension: $OUT"
echo "Chrome → Extensions → Developer mode → Load unpacked → select that folder."

if [[ "${VERIFY_NEXT:-}" == "1" ]]; then
  echo "VERIFY_NEXT=1: running Next.js production build..."
  (cd "${ROOT}/auralink-ai/frontend" && npm run build)
fi
