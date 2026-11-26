# Deal Pinger: handoff

Last updated: 26 November 2026. Read this first if you're picking the project up (a new Claude session, a session on the owner's PC, or a developer).

## What it is

A personal Swoopa-style reselling alert app for the UK. The owner saves searches (e.g. "PS5 under £300 near E8"), and Deal Pinger watches **eBay UK, Facebook Marketplace, Vinted, Gumtree and Depop**. It pings their iPhone (web push), plus optional **Telegram** and **Discord**, when a new matching listing appears or a seen one drops in price. Each deal comes with profit estimates (eBay sold prices, optional CeX prices), a scam check, and a flips tracker.

The README describes every feature for the owner. This file covers **state, decisions and next steps**.

## Where things are

| What | Where |
|---|---|
| Code | GitHub `mondeyyyyyy/deal-pinger`. Branches `main` and `claude/initial-build` are identical: push every change to both |
| Hosting | Railway project `charismatic-education`, service **Deal-pinger** (Dockerfile build) |
| Live URL | https://deal-pinger-production.up.railway.app |
| Data | SQLite at `/data/deal-pinger.db` on a Railway volume mounted at `/data` |
| Original design and plan | `docs/superpowers/specs/2026-11-26-deal-pinger-design.md`, `docs/superpowers/plans/2026-11-26-deal-pinger.md` |
| Original build session | https://claude.ai/code/session_01QAEMfr4urkYZYPC573n4GL |

**Railway variables set:** `APP_PASSWORD` (the owner set it). The push keys and session secret are generated automatically and stored in the database.
**Not set yet:** `EBAY_APP_ID`, `EBAY_CERT_ID` (see "Open issues"). Optional: `FACEBOOK_LOCATION` (default `london`), `PROXY_URL`, `BROWSER_CONCURRENCY` (default 2).

**Railway region:** set to `europe-west4-drams3a` (Amsterdam) through the API; it was `sfo`. Check it stuck after the next deploy.
**Railway deploy branch:** still `claude/initial-build`. The project token couldn't change it, and it doesn't matter because both branches are kept identical. The owner can switch it to `main` in Railway → Settings → Source.
**Spare volume:** `deal-pinger-volume-Up7x` is unattached and empty (created by mistake). It can be deleted in Railway.

## Live status (first real run, from Railway, 26 Nov 2026)

| Source | Status | Notes |
|---|---|---|
| Gumtree | ✅ Working | 25 listings in 1.3s |
| Facebook Marketplace | ⚠️ 0 listings | Page loads but no listing links (took ~16s = selector timeout). Commit `85b113e` now records what the page shows. Check the Railway logs for `no listings; page "…" showed: …` |
| Depop | ⚠️ 0 listings | Same as Facebook |
| eBay | ❌ HTTP 403 | Website fallback is refused from Railway. **Fix: official API keys** (owner must create them) |
| Vinted | ❌ HTTP 404 | `/api/v2/catalog/items` returns 404 from Railway. Vinted has changed something. Needs live investigation |
| CeX prices | ❌ HTTP 403 | `wss2.cex.uk.webuy.io` refuses Railway. See the decision below |

## Open issues, in priority order

1. **eBay API keys.** Waiting on the owner. Walkthrough: developer.ebay.com → Application Keys → **Production** keyset → claim the Marketplace Account Deletion exemption (the app stores no eBay user data) → add `EBAY_APP_ID` and `EBAY_CERT_ID` in Railway Variables → Deploy. The code path already exists (`src/sources/ebay.js`, Browse API with client-credentials OAuth, `EBAY_GB`). With keys, eBay also gives listing times, seller feedback and Buy It Now checkout links.
2. **Vinted 404.** Needs someone who can reach vinted.co.uk (the owner's PC; the cloud sandbox is blocked) to see what the site calls now, then update `src/sources/vinted.js` (`buildApiUrl`, `details`, `sellerInfo`, the cookie flow). The fixture tests in `test/sources.test.js` and `test/round6.test.js` describe the expected parsed shape.
3. **Facebook / Depop return 0 listings.** After `85b113e` deploys, tap "Check now" and read the logs (or Settings → Marketplaces, which shows amber with the page text). Then:
   - **Cookie/consent page:** fine to handle by choosing the site's own "only necessary cookies" option.
   - **Changed markup:** update the link selectors (`a[href*="/marketplace/item/"]`, `a[href*="/products/"]`) and the card parsing in `src/sources/cards.js`.
   - **Login wall or bot check:** see the constraint below. Don't try to get past it.
4. **CeX: owner decision pending.** Options offered: (a) **manual CeX prices** per search (cash and voucher fields plus a "Check on CeX" link that opens their site), feeding the existing CeX filter and profit maths; or (b) remove the automatic lookup so it stops showing the error. Nothing was built yet.
5. **iPhone setup** isn't finished by the owner: Settings showed "0 iPhones getting alerts". They need to add it to the Home Screen from Safari, open it from there, then Settings → Push notifications → Turn on.

## Constraints and decisions (please keep them)

- **Don't get round blocks.** When a site refuses the server (403, bot check, login wall), the fix is an official API (eBay), a residential `PROXY_URL` the owner chooses, or running from the owner's own connection. Don't disguise requests or force past bot protection: an attempt to do this for CeX was rightly blocked.
- **No auto-buying and no auto-messaging.** Both risk account bans, and a bot spending money on a misread listing is the costliest failure. Buy now links go to the marketplace's own checkout, and messages are copied for the owner to send.
- **Seller messages mention collecting only** on Facebook and Gumtree, or when the listing or description says "collection only", "pick up" and so on (`public/messages.js`). Vinted, Depop and eBay never get collection wording.
- **Scam filter:**
  - Defaults to *hide*.
  - High risk:
    - far below the usual price from a seller with no ratings or a new account;
    - the **£150+ item at £50–£120 from a brand-new account** rule (`src/scam.js`, `isBaitPrice`);
    - payment red flags from an untrusted seller.
  - Hidden scams never ping and never get Buy now links.
- **Never silently drop a deal.** An unknown profit or an unknown CeX price still pings. Profit minimums and CeX filters only suppress a ping when the figure is actually known.
- **New and edited searches seed silently.** The first check records existing listings without pinging. If a site's first check came back empty and it later returns more than 3 new listings, that's treated as the site having been blocked and is seeded silently too.
- The owner can't keep a PC on all the time. Railway is the 24/7 core; anything on the PC must be optional.

## How the code fits together

```
src/index.js          wires everything; per-minute digest/quiet-hours timer
src/poller.js         scheduler: a job per (search, marketplace), fetch lane (eBay, Vinted) and
                      browser lane (Facebook, Gumtree, Depop); runSourceOnce = fetch, match, seed,
                      price drops, estimate, scam check, alert
src/sources/*.js      one module per marketplace: search(), parse(), lane, minIntervalSec,
                      optional details()/sellerInfo()
src/browser.js        Playwright: warm context per site, images blocked, login-wall detection,
                      empty-page notes
src/match.js          keywords (a | b variants), whole-word skip words, WANTED/swap filter
src/comps.js          eBay sold prices (cleaned, robust median), buildEstimate (eBay + CeX)
src/cex.js            CeX lookups (currently 403 from Railway)
src/scam.js           scam rules
src/notify.js         web push, Discord embeds, Telegram (photo and text), summaries, quiet hours
src/db.js             SQLite schema, migrations, everything persistent
src/server.js         Express API (login, searches, hits, flips, settings, backup/restore, insights)
src/digest.js         evening summary
public/               the iPhone web app (app.js, index.html, sw.js, messages.js, tools.js)
test/                 node:test suites
```

## Working on it

```bash
npm install
npm test                      # 205 tests, all passing at 85b113e (about 30s; some launch Chromium)
APP_PASSWORD=dev DATA_DIR=./data npm start    # http://localhost:3000
```

- Write tests first (the history follows red → green). Run the whole suite before committing.
- Push to **both** branches: `git push origin HEAD:claude/initial-build HEAD:main`. Railway redeploys automatically.
- Bump `SHELL` in `public/sw.js` (`deal-pinger-shell-vN`, currently v15) whenever app files change, so phones pick up the new version.
- **Railway API** (for logs and status): GraphQL at `https://backboard.railway.com/graphql/v2` with a *project token* in the `Project-Access-Token` header. The original session stored one through its secure credential form; it isn't in the repo. Useful queries: `deployments(first:1, input:{serviceId, environmentId})`, then `deploymentLogs(deploymentId, limit)`. IDs: project `cc89b83b-ce80-494a-9da7-1674038b6112`, service `7aa9874e-9c7e-4d24-87c9-6fe392e19fb8`, environment `13587b1a-5e82-4240-a869-cca36c843c0b`.
- The cloud sandbox **can't reach** the marketplaces, CeX or the live app URL. Only Railway's logs show real-world behaviour.

## Ideas not built yet

- Manual CeX prices (see open issue 4).
- An optional **home helper**: when the owner's PC is on, it does the browser-site checks from their home connection (and logged-in Facebook, for seller account age); when it's off, Railway does them.
- Importing eBay or Vinted sales-history exports into Flips.
