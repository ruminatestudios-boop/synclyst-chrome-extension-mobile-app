## What does this change?
<!-- One sentence summary -->

## Which parts does this touch?
- [ ] Chrome extension popup (`popup.js` / `popup.html`)
- [ ] Content script / Magic Fill (`content-script.js`)
- [ ] Extension manifest (`build-manifest.mjs`)
- [ ] Frontend API routes (`app/api/`)
- [ ] Frontend pages (`app/`)
- [ ] Backend Python (`auralink-ai/backend/`)
- [ ] Shared libs (`lib/`)
- [ ] Landing page

## Pre-merge checklist
- [ ] Tested locally (reload extension + do a real scan)
- [ ] No `localhost` / dev URLs left in production code
- [ ] If backend changed → redeploy Cloud Run after merge
- [ ] If manifest changed → prod manifest validated (`npm run extension:manifest`)
- [ ] If `listing_extra` merge logic changed → tested description doesn't bleed between scans
- [ ] If price logic changed → tested that price shows (not 0.00)
- [ ] Drafts library still shows correct entries per scan

## Risk level
- [ ] 🟢 Low — cosmetic / copy only
- [ ] 🟡 Medium — logic change in non-critical path
- [ ] 🔴 High — scan flow, quota, billing, Magic Fill, or manifest
