# Live E2E: phone snap → extension listing

Run this after **Next** (e.g. Vercel) and the **vision API** (FastAPI) are deployed and env vars are set. See `frontend/DEPLOY-LIVE.md` for deploy basics.

## Phone QR (iOS) and `http` LAN

The extension’s QR may encode **`https://synclyst.app/q.html#...`** (a short bridge) when your resolved origin is an **`http://` LAN** URL, because iOS Camera often only offers to **copy** non-HTTPS links. The bridge page opens in Safari, then sends you to the real `/snap` on your network. The **`/q.html`** file must be deployed (it lives in `public/q.html`).

## Preconditions (production)

1. **`https://synclyst.app/api/snap-pair/config`** (or your domain) returns **200** JSON with `configured: true` and Supabase fields as expected.
2. **Vision backend** is reachable from Vercel: set **`NEXT_PUBLIC_API_URL`** or **`AURALINK_BACKEND_URL`** in production to your **live** FastAPI base URL (no trailing slash). If this still points at `localhost:8000`, snap-pair push will fail or time out in the cloud.
3. **Supabase**: `SUPABASE_SERVICE_ROLE_KEY` and table `snap_pair_sessions` (or your configured store) so session rows persist.
4. **CORS** on the FastAPI: allow `https://synclyst.app` (and your preview domain if testing a Vercel preview).
5. **Chrome extension**: use the **store / production manifest** build so the popup defaults to **`https://synclyst.app`** (not a dev manifest with localhost). If you sideload a custom build, clear or set `chrome.storage.local` `synclyst_origin` to your live origin if you ever tested locally.

## Quick API checks (browser or curl)

- `GET https://synclyst.app/api/snap-pair/config` → 200, JSON.
- Open `https://synclyst.app/snap` — page loads; optional: `?s=<hex session id>` if you already have a code.

## End-to-end test (happy path)

1. On the **desktop** (Chrome with SyncLyst installed), open the **extension popup**.
2. Note the **pairing session id** and QR (or use “Copy link”). Do not use a dev-only `127.0.0.1` link on the phone for this test—use the **live** `https://synclyst.app/...` link so the phone and extension hit the **same** API.
3. On the **phone**, open that link (or scan the QR), allow camera/photos, and **upload a clear product photo**.
4. Wait for the snap page to show success (upload + server extraction finished).
5. On the **desktop**, open the extension again (or leave it open on the listing step). You should see **“Extracting…”** clear and **title / description / image** fill when `GET /api/snap-pair/session/{id}` returns a listing with real content. Supabase Realtime, when configured, can make this feel instant; otherwise the ~800ms HTTP poll still picks it up within a few seconds.
6. Optional: pick a platform and use **Magic Fill** on an open seller tab to confirm the full loop.

## If the extension stays empty

- **Wrong origin**: extension still pointing at a cached localhost in storage — set **`synclyst_origin`** in `chrome.storage.local` to `https://synclyst.app` or open a tab to `https://synclyst.app/snap` and reload the popup (see `resolveSynclystOrigin` in `extension/popup.js`).
- **Push never stored a row**: check Vercel logs for `/api/snap-pair/push` and the vision API logs; 502/503 often mean vision API URL or Supabase misconfiguration.
- **Session id mismatch**: new pairing code on the extension but phone still on an old bookmarked `?s=` link — rescan the current QR.

## Vercel preview

If you test on `https://<project>.vercel.app`, the extension manifest already includes `https://*.vercel.app/*` for snap-bridge and API; ensure the **same** preview host is what you open on the phone and that env vars for that deployment point to a **reachable** vision API and Supabase.
