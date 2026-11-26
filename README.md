# Deal Pinger

Your own Swoopa-style reselling alert app. Save searches like "Nintendo Switch under $200 within 25 miles", and Deal Pinger watches **eBay, Craigslist, Facebook Marketplace, OfferUp and Mercari** every ~90 seconds and pings your iPhone the moment a new match is posted. Each alert includes an estimated resale value and profit, based on recent eBay sold prices.

## Features

- **Instant push alerts** on your iPhone, even when the app is closed.
- **Profit estimates.** Resale value is the median of recent eBay sold prices. Profit is that value minus eBay fees (13.25%), your shipping estimate and the asking price.
- **Price history** per search: a chart of asking prices against the eBay sold median.
- **One-tap seller message.** "Message" copies your saved message (e.g. "Hi! Is this still available? I can pick up today for {offer}.") and opens the listing, so you just paste and send. `{offer}` is about 85% of the asking price.
- **Filters:** price range, zip and radius, words to skip ("broken, parts, box only"), and "only ping if profit is at least $X".
- **Quiet hours.** No pings overnight; deals still collect in your feed.
- **Save or hide deals**, pause searches, and "Check now".
- **Marketplace status page**, so you can see when a site is working or blocked.
- Dark mode, and a password lock.
- New searches don't flood you: listings already up when you create a search are skipped, and you only get pinged for ones posted after.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo →** pick `deal-pinger`. Railway finds the `Dockerfile` automatically.
2. **Add a volume:** right-click the service → **Attach Volume** → mount path `/data`. This keeps your searches and deals between deploys.
3. **Variables** (service → Variables):

   | Variable | Required | What it is |
   |---|---|---|
   | `APP_PASSWORD` | ✅ | The password you'll log in with |
   | `TZ` | recommended | Your timezone for quiet hours, e.g. `America/New_York` |
   | `CRAIGSLIST_SITE` | recommended | Your Craigslist area: the part before `.craigslist.org` (e.g. `losangeles`, `newyork`, `sfbay`) |
   | `FACEBOOK_LOCATION` | recommended | Your Marketplace city: open facebook.com/marketplace, set your location, and copy the word after `/marketplace/` in the address bar (e.g. `nyc`, `la`, or a long number) |
   | `EBAY_APP_ID`, `EBAY_CERT_ID` | optional | Free eBay API keys (see below). Without them eBay still works by reading the website, just less reliably |
   | `PROXY_URL` | optional | A residential proxy, e.g. `http://user:pass@host:port`, if Facebook, OfferUp or Mercari start blocking Railway |
   | `POLL_INTERVAL_SEC` | optional | How often to check, default `90` |

4. **Settings → Networking → Generate Domain.** You'll get a URL like `https://deal-pinger-production.up.railway.app`.
5. Give the service at least **1 GB of memory** (the headless browser for Facebook, OfferUp and Mercari needs it).

Push notification keys are generated automatically on first start and saved on the volume, so there's nothing to set up for push.

## Put it on your iPhone

1. Open your Railway URL in **Safari** and log in.
2. Tap **Share → Add to Home Screen**. Push alerts on iPhone only work from the Home Screen app (iOS 16.4 or newer).
3. Open **Deal Pinger** from your Home Screen, log in, go to **Settings → Turn on**, and allow notifications.
4. Tap **Send** next to "Send a test alert" to confirm alerts reach your phone.
5. Go to **Searches → +** and add what you flip.

## Getting eBay API keys (optional, free)

1. Sign in at [developer.ebay.com](https://developer.ebay.com) and create a developer account.
2. Go to **Application Keys** and create a **Production** keyset.
3. Copy the **App ID (Client ID)** into `EBAY_APP_ID` and the **Cert ID (Client Secret)** into `EBAY_CERT_ID`.

## Good to know

- **Facebook, OfferUp and Mercari have no public API**, so Deal Pinger reads their pages with a headless browser. This is against their terms of service, and they change their pages and block cloud servers from time to time. If one shows **Failing** on the Settings screen, it's usually blocking; adding a `PROXY_URL` (a residential proxy service) normally fixes it. Craigslist and eBay are much more stable.
- Profit estimates are only as good as the eBay sold comps for your keywords. Specific searches ("switch oled") give better estimates than vague ones ("switch").
- Deal Pinger doesn't auto-buy or auto-message. Bots on your marketplace accounts get them banned, and a bot spending money on a misread listing is an expensive mistake. Alerts plus one-tap messages get you most of the speed.

## Development

```bash
npm install
npm test
APP_PASSWORD=dev npm start   # http://localhost:3000
```

Code map: `src/sources/*` reads each marketplace, `src/poller.js` runs searches and detects new listings, `src/comps.js` handles eBay sold prices and profit, `src/notify.js` sends push alerts, `src/server.js` is the API, and `public/` is the iPhone app.
