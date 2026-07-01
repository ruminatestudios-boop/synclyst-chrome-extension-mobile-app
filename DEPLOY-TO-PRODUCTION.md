# SyncLyst — Production Deployment Checklist

Domain: **synclyst.app** (Vercel)  
Backend: **Google Cloud Run**  
Auth: **Clerk**  
Payments: **Stripe**

---

## Step 1 — Clerk production keys

1. Go to [dashboard.clerk.com](https://dashboard.clerk.com)
2. Switch to **Production** and verify domain `synclyst.app`
3. Copy **Publishable key** (`pk_live_...`) and **Secret key** (`sk_live_...`)
4. Add them to Vercel (Step 3) and `cloud-run-env.yaml` (Step 2)

---

## Step 2 — Deploy Python backend to Cloud Run

Install gcloud CLI: https://cloud.google.com/sdk/docs/install

```bash
gcloud auth login
gcloud auth configure-docker us-central1-docker.pkg.dev

cd auralink-ai/backend
cp cloud-run-env.example.yaml cloud-run-env.yaml
# Edit cloud-run-env.yaml with your secrets (this file is gitignored)

bash deploy-cloud-run.sh YOUR_GCP_PROJECT_ID
```

Publishing service:

```bash
cd auralink-ai/publishing
cp cloud-run-env.example.yaml cloud-run-env.yaml
# Edit cloud-run-env.yaml with your secrets

bash deploy-cloud-run.sh YOUR_GCP_PROJECT_ID
```

**Copy both Cloud Run URLs** for Step 3.

Free-tier quota (in `cloud-run-env.yaml`):

```yaml
STARTER_SCAN_QUOTA_WINDOW: "lifetime"
STARTER_SCAN_LIMIT: "3"
```

---

## Step 3 — Vercel environment variables

Vercel → synclyst.app → **Settings → Environment Variables**

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://synclyst.app` |
| `NEXT_PUBLIC_API_URL` | Your backend Cloud Run URL |
| `AURALINK_BACKEND_URL` | Same backend Cloud Run URL |
| `NEXT_PUBLIC_PUBLISHING_API_URL` | Your publishing Cloud Run URL |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | From Clerk dashboard |
| `CLERK_SECRET_KEY` | From Clerk dashboard |
| `NEXT_PUBLIC_SUPABASE_URL` | From Supabase project |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | From Supabase project |
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase project |
| `STRIPE_SECRET_KEY` | From Stripe dashboard |
| `STRIPE_PRICE_PRO` / `GROWTH` / `SCALE` | Stripe price IDs |
| `STRIPE_WEBHOOK_SECRET` | From Stripe webhook |
| `PUBLISHING_JWT_SECRET` | Same as publishing `JWT_SECRET` |
| `JWT_SECRET` | Random secret shared with publishing service |

Redeploy Vercel after updating variables.

---

## Step 4 — Stripe webhook

1. [dashboard.stripe.com/webhooks](https://dashboard.stripe.com/webhooks) → **Add endpoint**
2. URL: `https://YOUR_BACKEND_URL/api/v1/billing/webhook`
3. Events: `checkout.session.completed`, `customer.subscription.*`
4. Copy signing secret → `STRIPE_WEBHOOK_SECRET` in Cloud Run + Vercel

---

## Step 5 — Shopify app URLs

Shopify Partners → your app → **App setup**:

- **App URL**: `https://synclyst.app`
- **Redirect URL**: `https://YOUR_PUBLISHING_URL/auth/shopify/callback`
- **GDPR webhooks**: `https://YOUR_PUBLISHING_URL/webhooks/shopify/compliance`

---

## Step 6 — Smoke test

- [ ] https://synclyst.app loads
- [ ] Sign up → `/dashboard`
- [ ] Upload photo → extraction runs
- [ ] 4th guest scan → paywall (3 lifetime free scans)
- [ ] Extension popup → reload after publish
- [ ] Snap/QR → phone upload → draft in popup
