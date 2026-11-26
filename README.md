# Deal Pinger 🇬🇧

Your own Swoopa-style reselling alert app for the UK. Save searches like "Nintendo Switch under £150 within 10 miles of E8", and Deal Pinger watches **eBay UK, Facebook Marketplace, Vinted, Gumtree and Depop** every ~90 seconds. It pings your iPhone the moment a new match is posted, or when a listing you've already seen drops its price, and shows how much profit is in it.

## Features

- **Instant push alerts** on your iPhone, even when the app is closed.
- **Price-drop alerts** when a listing you've already seen gets at least 5% cheaper. These show as "£85 → £70".
- **Profit estimates.** Resale value is the median of recent **eBay UK sold** prices, or your own figure ("I can resell these for £…"). From that, Deal Pinger subtracts your selling fee and postage, then the asking price. The fee defaults to 0%, because private sellers on eBay UK and Vinted pay no selling fees.
- **Sort by best profit**, or filter to saved deals or price drops.
- **Price history** per search: a chart of asking prices against the eBay sold median.
- **One-tap seller message.** "Message" copies your saved message (e.g. "Hi! Is this still available? I can collect today for {offer}.") and opens the listing, so you just paste and send. `{offer}` is about 85% of the asking price.
- **Filters:** price range, postcode and radius, words to skip ("faulty, spares, box only"), and "only ping if profit is at least £X".
- **Quiet hours** (UK time). Deals still collect in your feed.
- **Marketplace status page**, so you can see when a site is working or blocked.
- Save or hide deals, pause searches, "Check now", dark mode, and a password lock.
- New and edited searches don't flood you: listings already up are skipped, and only ones posted afterwards ping you.
- Old data is cleaned up automatically, so it stays quick after months of running.

## Deploy on Railway

1. **New Project → Deploy from GitHub repo →** pick `deal-pinger`. Railway finds the `Dockerfile` automatically.
2. **Add a volume:** right-click the service → **Attach Volume** → mount path `/data`. This keeps your searches and deals between deploys.
3. **Variables** (service → Variables):

   | Variable | Required | What it is |
   |---|---|---|
   | `APP_PASSWORD` | ✅ | The password you'll log in with |
   | `FACEBOOK_LOCATION` | recommended | Your Marketplace city: open facebook.com/marketplace, set your location, and copy the word after `/marketplace/` in the address bar (e.g. `london`, `manchester`, `birmingham`, or a long number). Default `london` |
   | `EBAY_APP_ID`, `EBAY_CERT_ID` | optional | Free eBay API keys (see below). Without them eBay still works by reading ebay.co.uk, just less reliably |
   | `PROXY_URL` | optional | A UK residential proxy, e.g. `http://user:pass@host:port`, if Facebook, Vinted, Gumtree or Depop start blocking Railway |
   | `POLL_INTERVAL_SEC` | optional | How often to check, default `90` |

   Postcode and radius are set per search in the app. Timezone defaults to UK time.
4. **Settings → Networking → Generate Domain.** You'll get a URL like `https://deal-pinger-production.up.railway.app`.
5. Give the service at least **1 GB of memory** (the headless browser for Facebook, Gumtree and Depop needs it). If you can, pick an **EU West** region: it's closer to the UK sites.

Push notification keys are generated automatically on first start and saved on the volume, so there's nothing to set up for push.

## Put it on your iPhone

1. Open your Railway URL in **Safari** and log in.
2. Tap **Share → Add to Home Screen**. Push alerts on iPhone only work from the Home Screen app (iOS 16.4 or newer).
3. Open **Deal Pinger** from your Home Screen, log in, go to **Settings → Turn on**, and allow notifications.
4. Tap **Send** next to "Send a test alert" to confirm alerts reach your phone.
5. If you sell as a business on eBay, set **Settings → Selling fee** to about 13%.
6. Go to **Searches → +** and add what you flip.

## Getting eBay API keys (optional, free)

1. Sign in at [developer.ebay.com](https://developer.ebay.com) and create a developer account.
2. Go to **Application Keys** and create a **Production** keyset.
3. Copy the **App ID (Client ID)** into `EBAY_APP_ID` and the **Cert ID (Client Secret)** into `EBAY_CERT_ID`.

## How each marketplace is read

| Marketplace | How | Reliability |
|---|---|---|
| eBay UK | Official API (with keys), otherwise the ebay.co.uk website. UK sellers only | High |
| Vinted | Vinted's own website API, with a real-browser fallback | Medium |
| Facebook Marketplace | Headless browser | Medium: Facebook blocks cloud servers at times |
| Gumtree | Headless browser | Medium |
| Depop | Headless browser | Medium |

Facebook, Vinted, Gumtree and Depop have no public API, so reading them is against their terms of service, and they change their pages and block cloud servers from time to time. If one shows **Failing** on the Settings screen, it's usually blocking; adding a `PROXY_URL` (a UK residential proxy service) normally fixes it.

Vinted and Depop are delivery-only, so postcode and radius don't apply to them. Profit estimates are only as good as the eBay sold prices for your keywords: specific searches ("switch oled") work better than vague ones ("switch"). For clothes, setting your own resale value is often more accurate.

Deal Pinger doesn't auto-buy or auto-message. Bots on your marketplace accounts get them banned, and a bot spending money on a misread listing is an expensive mistake. Fast alerts plus one-tap messages get you most of the speed.

## Development

```bash
npm install
npm test
APP_PASSWORD=dev npm start   # http://localhost:3000
```

Code map: `src/sources/*` reads each marketplace, `src/poller.js` runs searches and spots new listings and price drops, `src/comps.js` handles eBay sold prices and profit, `src/notify.js` sends push alerts, `src/server.js` is the API, and `public/` is the iPhone app.
