# Deploy SyncLyst (Next.js) to production

Use this when pointing **https://synclyst.app** (or your domain) at this app. The repo’s full checklist is `../LAUNCH-CHECKLIST.md`; this is the **minimum Vercel path**.

## 1. Vercel project

1. Import the Git repo.
2. **Root Directory:** `auralink-ai/frontend` (required).
3. Framework: Next.js (default). **Install command:** `npm ci` (already in `vercel.json`).
4. **Build command:** `npm run build` (default).
5. Deploy once with defaults; then add env vars and redeploy.

## 2. Environment variables (Production)

Copy from `.env.example` and set in **Vercel → Settings → Environment Variables → Production**.

| Variable | Notes |
|----------|--------|
| `NEXT_PUBLIC_APP_URL` | `https://synclyst.app` (no trailing slash). Stripe success/cancel URLs. |
| `NEXT_PUBLIC_API_URL` or `AURALINK_BACKEND_URL` | Your live FastAPI URL (no trailing slash). |
| Clerk | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, JWT template vars |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_SCALE` (+ optional `STRIPE_PRICE_STARTER` per `lib/stripe-tier-map.ts`) |
| Publishing proxy | `PUBLISHING_PROXY_TARGET` if your publish service is not the default in `next.config.ts` |

Redeploy after changing env vars so the build picks up `NEXT_PUBLIC_*`.

## 3. Custom domain

Vercel → Domains → add `synclyst.app` / `www` per DNS instructions.

## 4. Backend CORS

Set `CORS_ORIGINS` on your API to include `https://synclyst.app` (see `../LAUNCH-CHECKLIST.md` §1).

## 5. Verify

- `https://synclyst.app/api/snap-pair/config` → **200** JSON (extension + phone pairing).
- `https://synclyst.app/billing` → loads (Clerk + Stripe when configured).
- Chrome extension: with no local dev server, popup should resolve **`https://synclyst.app`** automatically (`extension/popup.js`).
- **Phone → extension listing (full E2E):** follow `../docs/live-snap-pair-e2e.md` after deploy.

## 6. CLI (optional)

```bash
cd auralink-ai/frontend
npx vercel login
npx vercel --prod
```

Link the project when prompted; set the same env vars in the Vercel dashboard if the CLI project is new.
