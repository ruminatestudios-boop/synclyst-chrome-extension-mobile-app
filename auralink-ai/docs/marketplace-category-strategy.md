# Marketplace categories (SyncLyst)

## Principles

1. **Universal / vision category is a hint only**  
   Text from extraction (tags, attributes, keywords) describes the product in the abstract. It is **not** a stable identifier on any marketplace.

2. **Per-marketplace truth lives in `listing_extra.{platform}`**  
   Store each channel’s real identifiers there, e.g. Shopee:

   - `category_id` — native leaf id when known  
   - `category_path` — optional breadcrumb (`string[]`) for display and debugging  
   - `category_hint` / `category_search` — non-authoritative search strings from vision  
   - `category_source` — `universal_hint` | `suggestion_api` | `barcode_lookup` | `user_ui`  
   - `category_needs_confirmation` — when true, Magic Fill must not auto-confirm an ambiguous leaf  
   - `barcode` — when present, enables future **catalog / barcode** resolution without maintaining in-repo crosswalks

3. **How values get filled (priority)**  
   - **Suggestion API** (where the marketplace exposes one) → set `category_id`, `category_path`, `category_source`, `category_confidence` when implemented per platform.  
   - **Barcode / catalog lookup** when `barcode` (UPC/EAN) exists → resolve leaf id via platform or third-party catalog; still no giant static map in this repo.  
   - **User selection** in the listing UI → persist via session `listing_extra` (PUT listing or future extension save) with `category_source: "user_ui"`.  
   - **Universal hint only** → `category_hint` / `category_search`; extension uses them to **search** the picker, not as a guaranteed leaf.

4. **Ambiguity**  
   If a suggestion API returns ties or low confidence, set `category_needs_confirmation: true`. The extension should pre-fill search but **not** auto-click a leaf until the user confirms (Shopee implements this for `category_needs_confirmation`).

5. **No giant crosswalk maps**  
   Do not maintain large “universal → Shopee id” tables in the repo. Prefer APIs, barcode lookup, or persisted user choices.

6. **Ship one platform end-to-end, then copy the pattern**  
   **Shopee** is the reference implementation: `lib/snap-pair-shopee-extra.ts`, merge rules in `mergeShopeeIntoListingExtra`, extension `listing_extra.shopee` consumers. Other marketplaces get the same shape under `listing_extra.{platform}` when we add them.

## Session persistence

`snap_pair_sessions.listing_extra` is JSON. Merges from vision **do not overwrite** an existing `category_id` or an authoritative `category_source`. Client PUTs should send merged objects if updating piecemeal.
