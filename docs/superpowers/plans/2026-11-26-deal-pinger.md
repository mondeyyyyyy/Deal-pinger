# Deal Pinger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Always-on server that polls 5 marketplaces for saved searches and sends iPhone web-push alerts for new matches, plus an installable PWA to manage searches and view hits.

**Architecture:** One Node process: Express API + static PWA, a poller loop that runs each enabled search through each selected source module, dedups via SQLite, and pushes new hits with `web-push`. Sources are isolated modules returning a common `Listing` shape; failures are caught per source.

**Tech Stack:** Node 22 (ESM), `node:sqlite`, Express 4, `web-push`, Playwright (Chromium), `node:test`. Docker for Railway.

**Spec:** `docs/superpowers/specs/2026-11-26-deal-pinger-design.md`

## Global Constraints
- Node >= 22.13 (unflagged `node:sqlite`).
- Data lives in `DATA_DIR` (default `./data`; `/data` on Railway volume), DB file `deal-pinger.db`.
- Env: `APP_PASSWORD` (required), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `EBAY_APP_ID`, `EBAY_CERT_ID`, `PROXY_URL` (optional), `POLL_INTERVAL_SEC` (default 90), `PORT` (default 3000).
- Source ids exactly: `ebay`, `craigslist`, `facebook`, `offerup`, `mercari`.
- `Listing` = `{ source, id, title, price: number|null, url, image: string|null, location: string|null, postedAt: string|null }`.

## Review Focus
- First run of a new search must alert nothing (seed seen-set silently) — test in Task 2.
- A source throwing or timing out must not stop other sources or the loop — test in Task 4.
- Listing with no parsable price ("Free", "$1,250.00", missing) — test in Task 2 (`parsePrice`).
- Dead push subscription (HTTP 404/410) must be deleted, not retried forever — test in Task 4.
- Wrong/missing password must get 401 on every `/api/*` route except `/api/login` — test in Task 5.

---

### Task 1: Scaffold + DB

**Files:** Create `package.json`, `.gitignore`, `src/config.js`, `src/db.js`; Test `test/db.test.js`

**Interfaces — Produces:**
- `loadConfig(env=process.env) -> Config` (fields mirror Global Constraints env, camelCased).
- `openDb(file: string) -> Db` with: `addSearch({name, keywords, minPrice, maxPrice, zip, radius, sources: string[]}) -> Search`, `listSearches() -> Search[]`, `updateSearch(id, patch) -> Search`, `deleteSearch(id)`, `markSeen(searchId, listings: Listing[]) -> Listing[]` (returns only unseen, records all), `hasSeenAny(searchId) -> boolean`, `addHit(searchId, listing)`, `recentHits(limit=100) -> Hit[]`, `addSubscription(sub)`, `listSubscriptions() -> Sub[]`, `removeSubscription(endpoint)`. `Search` has `enabled: boolean`, `sources: string[]`.

- [ ] Test: add/list/update/delete search round-trips; `markSeen` returns 2 new of 2 then 0 of the same 2, then 1 when a third is added; subscriptions dedupe on endpoint.
- [ ] Run `node --test test/` → FAIL. Implement. Run → PASS. Commit.

### Task 2: Matching + price parsing

**Files:** Create `src/match.js`; Test `test/match.test.js`

**Interfaces — Produces:** `parsePrice(text) -> number|null`; `matches(listing, search) -> boolean` (every keyword word appears case-insensitively in title; price within min/max when price known; unknown price passes).

- [ ] Test: `parsePrice("$1,250.00")===1250`, `parsePrice("Free")===0`, `parsePrice("")===null`; `matches` rejects over-max, accepts null price, requires all keywords.
- [ ] Fail → implement → pass → commit.

### Task 3: Sources

**Files:** Create `src/sources/{index,ebay,craigslist,facebook,offerup,mercari}.js`, `src/browser.js`; Test `test/sources.test.js` (parsers fed fixture HTML/JSON in `test/fixtures/`).

**Interfaces — Produces:** each module exports `{ id, search(search, ctx) -> Promise<Listing[]> }` plus a pure `parse(raw) -> Listing[]`. `ctx = { config, getPage }`. `sources/index.js` exports `SOURCES: Record<id, module>`. `browser.js` exports `getPage(config) -> Promise<Page>` (lazy shared Chromium, proxy from `PROXY_URL`) and `closeBrowser()`.
- eBay: OAuth client-credentials token (cached) → Browse API `item_summary/search` with `q`, `filter=price:[min..max]`, `sort=newlyListed`.
- Craigslist: fetch `https://<site>.craigslist.org/search/sss?query=&postal=&search_distance=&min_price=&max_price=&sort=date`, parse `li.cl-static-search-result` (site default `sfbay`, overridable per search via zip→nearest is out of scope; use `CRAIGSLIST_SITE` env).
- Facebook/OfferUp/Mercari: Playwright page load of the public search URL sorted newest; parse embedded listing anchors/JSON.

- [ ] Test each `parse()` against a fixture → ≥1 Listing with all required fields typed correctly.
- [ ] Fail → implement → pass → commit.

### Task 4: Poller + push

**Files:** Create `src/poller.js`, `src/notify.js`; Test `test/poller.test.js`

**Interfaces — Consumes:** Db, `SOURCES`, `matches`. **Produces:** `runSearchOnce(search, {db, sources, notify, ctx}) -> Promise<{newHits: Listing[], errors: {source, message}[]}>`; `startPoller(deps) -> stop()`; `createNotifier({db, config, webpush}) -> (search, listing) => Promise<void>` (deletes subs on 404/410).

- [ ] Test: first run seeds silently (notify not called); second run with one new listing calls notify once and records a hit; a source that throws yields an `errors` entry while the other source's hit still arrives; notifier removes a sub when webpush rejects with `statusCode: 410`.
- [ ] Fail → implement → pass → commit.

### Task 5: HTTP API + auth

**Files:** Create `src/server.js`, `src/index.js` (entry: config, db, poller, listen); Test `test/server.test.js`

**Interfaces — Produces:** `createApp({db, config, runNow}) -> express.App`. Routes: `POST /api/login {password}` → sets signed httpOnly cookie; `GET/POST /api/searches`, `PUT/DELETE /api/searches/:id`, `POST /api/searches/:id/run`, `GET /api/hits`, `GET /api/vapid`, `POST /api/subscribe`, `GET /healthz`.

- [ ] Test: unauthenticated `/api/searches` → 401; login wrong pw → 401; login ok then create + list search works.
- [ ] Fail → implement → pass → commit.

### Task 6: PWA

**Files:** Create `public/index.html`, `public/app.js`, `public/sw.js`, `public/manifest.webmanifest`, `public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png`.

- [ ] Login screen; Feed tab (hits with image, price, source, age, tap → listing URL); Searches tab (create/edit/toggle/delete, source checkboxes); "Enable alerts" button (subscribe via `/api/vapid`, shows Add-to-Home-Screen hint when not standalone). `sw.js` shows notification and opens listing URL on tap.
- [ ] Verify in Playwright at iPhone viewport: login → create search → appears; screenshot. Commit.

### Task 7: Deploy packaging

**Files:** Create `Dockerfile` (base `mcr.microsoft.com/playwright:v1.x-noble`), `railway.json`, `scripts/gen-vapid.js`, `README.md` (Railway steps, volume at `/data`, env vars, eBay keys, iPhone install steps, ToS/blocking caveat).

- [ ] `docker build` if available, else `node src/index.js` boots and `/healthz` returns 200. Commit and push.

### Task 8: Extras (from spec "Additions")
**Files:** `src/comps.js` (`parseSold(html) -> number[]`, `median(nums)`, `estimate(search, listing, {getSoldPrices}) -> {value, profit, score}|null`), DB columns `excludeWords`, `minProfit`, `shipEstimate`, `messageTemplate`, table `prices`, `settings` (quiet hours), hit `status` (new/saved/dismissed); routes `GET /api/searches/:id/history`, `PUT /api/hits/:id`, `GET/PUT /api/settings`, `POST /api/test-push`, `GET /api/status`.
- [ ] Tests: `estimate` math (value 200, price 100, ship 12 → profit 61.5); excluded word blocks match; minProfit suppresses notify but still records hit; quiet hours suppress push.
