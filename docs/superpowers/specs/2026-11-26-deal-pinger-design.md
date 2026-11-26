# Deal Pinger — Design

## Intent
A personal Swoopa-style reselling tool. The owner saves searches (keywords, price range,
location) and gets an iPhone push notification the moment a new matching listing appears on
a resale marketplace, so they can reach the seller before other flippers.

## Goals
- Saved searches: keywords, optional min/max price, zip + radius, which marketplaces.
- Watch all of: eBay, Craigslist, Facebook Marketplace, OfferUp, Mercari.
- Poll every 1–2 minutes per search; notify only on listings not seen before.
- iPhone push notifications while the app is closed.
- Feed of recent matches (photo, title, price, source, age); tap opens the listing.
- Deploys to Railway from GitHub.

## Non-goals
- App Store / native app.
- Multi-user accounts.
- Auto-messaging sellers, price history, profit estimates.

## Anti-goals
- One broken marketplace taking down the others.
- Flooding the user with repeat alerts for the same listing (including on first run of a search).

## Constraints
- iOS web push requires HTTPS and the app installed to Home Screen (iOS 16.4+).
- Facebook, OfferUp, Mercari have no public API: read via headless browser (Playwright).
  Fragile, against their ToS, and cloud IPs get blocked more readily. Optional proxy setting.
- eBay via official Browse API (needs free developer App ID + Cert ID).
- Craigslist via its public search pages.
- Railway: single always-on service, persistent volume for the SQLite DB, 0.5–1 GB RAM.

## Approaches considered
1. **Node server + installable PWA with Web Push (chosen).** Buildable and testable entirely
   from Linux, no Apple developer fee, push works on iOS 16.4+.
2. Native SwiftUI app + same server. Needs a Mac, Xcode and $99/yr; alerts are no faster.
3. Server sending alerts via a third-party push app (ntfy/Pushover). Simpler, but no feed or
   search management UI on the phone. Could be added later as an extra channel.

## Decided
- Hosting: Railway, Dockerfile build, volume mounted at `/data`.
- Single user protected by a password (`APP_PASSWORD`).
- Each marketplace is an independent source module; failures are logged and isolated.

## Left to the builder
- Exact scraping selectors / endpoints per site; polling jitter; storage schema.
- First run of a new search seeds "seen" listings silently (no alert burst).

## Additions (requested 2026-11-26)
- **Profit estimates:** estimated resale value = median of recent eBay *sold* prices for the
  search keywords (scraped from eBay sold-listings page, cached 12h per query). Profit =
  value × (1 − 0.1325 eBay fee) − `shipEstimate` (default $12, per search) − ask price.
  Deal score 0–100 from profit margin. Shown on each hit and in the push text.
- **Price history:** every seen listing price is stored; per-search chart of asking prices over
  time plus the sold median.
- **Seller messaging:** one-tap — per-search message template with `{price}`/`{title}`
  placeholders is copied to clipboard and the listing opens. No automated sending
  (account-ban risk; decided by builder, user may revisit).
- **Auto-buy:** not built (eBay Order API is restricted to approved partners; others have no
  safe checkout; spending money on a mis-parsed listing is the costliest failure).
- **QoL:** exclude words, min-profit alert threshold, quiet hours (global), save/dismiss hits,
  test notification, per-source health status, pause search, dark mode.

## UK edition (requested 2026-11-26)
- **UK marketplaces only:** eBay UK (ebay.co.uk, EBAY_GB, GBP), Facebook Marketplace (UK city),
  Vinted (vinted.co.uk), Gumtree, Depop. Craigslist, OfferUp, Mercari removed (US-only / unused in UK).
- Currency £; postcode instead of zip; timezone default Europe/London.
- Selling fee is a global setting, default 0% (eBay UK private sellers pay no final value fee
  since Oct 2024; Vinted charges sellers nothing). Shipping default £4.
- Per-search manual resale value override (used instead of eBay sold median when set).
- Price-drop alerts: a previously seen matching listing whose price falls by ≥5% alerts again.
- Feed sort by best profit. Old data pruned (seen > 45 days, non-saved hits > 60 days).
- "make it better" skill requested by user does not exist; improvements chosen by builder.
