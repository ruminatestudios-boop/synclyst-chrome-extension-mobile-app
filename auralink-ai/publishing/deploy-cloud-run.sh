#!/usr/bin/env bash
# Deploy SyncLyst Publishing API to Google Cloud Run
# Usage: bash deploy-cloud-run.sh <GCP_PROJECT_ID>
# Example: bash deploy-cloud-run.sh synclyst-prod
#
# Prerequisites:
#   cp cloud-run-env.example.yaml cloud-run-env.yaml
#   # edit cloud-run-env.yaml with production secrets (file is gitignored)
set -euo pipefail

PROJECT_ID="${1:-}"
if [ -z "$PROJECT_ID" ]; then
  echo "Usage: bash deploy-cloud-run.sh <GCP_PROJECT_ID>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/cloud-run-env.yaml"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing ${ENV_FILE}"
  echo "Copy cloud-run-env.example.yaml → cloud-run-env.yaml and fill in secrets."
  exit 1
fi

REGION="us-central1"
SERVICE="synclyst-publishing"

echo "→ Deploying $SERVICE to Cloud Run ($REGION)..."
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 5 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 60 \
  --project "$PROJECT_ID" \
  --env-vars-file "$ENV_FILE"

echo ""
echo "✅ Deployed! Get the publishing service URL:"
PUB_URL=$(gcloud run services describe "$SERVICE" \
  --region "$REGION" \
  --format='value(status.url)' \
  --project "$PROJECT_ID")
echo "$PUB_URL"

echo ""
echo "⚠️  Next steps:"
echo "  1. In Vercel → synclyst.app → Settings → Environment Variables:"
echo "     NEXT_PUBLIC_PUBLISHING_API_URL = $PUB_URL"
echo "  2. Register the Shopify callback URL in Shopify Partners → your app:"
echo "     $PUB_URL/auth/shopify/callback"
echo "  3. For GDPR compliance webhooks, register in Shopify Partners → Webhooks:"
echo "     $PUB_URL/webhooks/shopify/compliance"
