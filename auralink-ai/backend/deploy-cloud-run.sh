#!/usr/bin/env bash
# Deploy SyncLyst backend API to Google Cloud Run
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
SERVICE="synclyst-api"

echo "→ Enabling required APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  --project="$PROJECT_ID"

echo "→ Deploying $SERVICE to Cloud Run ($REGION)..."
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 10 \
  --memory 1Gi \
  --cpu 1 \
  --timeout 120 \
  --project "$PROJECT_ID" \
  --env-vars-file "$ENV_FILE"

echo ""
echo "✅ Deployed! Get the service URL:"
gcloud run services describe "$SERVICE" \
  --region "$REGION" \
  --format='value(status.url)' \
  --project "$PROJECT_ID"

echo ""
echo "⚠️  Next steps:"
echo "  1. Copy the URL above"
echo "  2. In Vercel → synclyst.app → Settings → Environment Variables:"
echo "     AURALINK_BACKEND_URL = <paste Cloud Run URL>"
echo "  3. Register Stripe webhook: https://dashboard.stripe.com/webhooks"
echo "     Endpoint URL: <Cloud Run URL>/api/v1/billing/webhook"
echo "     Events: checkout.session.completed, customer.subscription.*"
