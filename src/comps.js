import { parsePrice, mainKeywords } from './match.js';

export function median(nums) {
  const a = nums.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Resale value = the search's manual override, else the median eBay UK sold price.
 * Profit = value minus selling fee (feePct, default 0: eBay UK private sellers and Vinted sellers pay none),
 * minus shipping, minus the asking price.
 */
export function estimate(search, listing, soldPrices, { feePct = 0 } = {}) {
  const override = search.resaleOverride ?? null;
  const value = override ?? median(soldPrices || []);
  if (value == null || listing.price == null) return null;
  const cost = listing.price + (listing.extraCost || 0); // e.g. Vinted's buyer protection fee
  const profit = round2(value * (1 - feePct / 100) - (search.shipEstimate ?? 4) - cost);
  const base = Math.max(listing.price, 1);
  const score = Math.max(0, Math.min(100, Math.round((profit / base) * 100)));
  return { value: round2(value), profit, score, comps: override != null ? 0 : soldPrices.length };
}

/** Parse sold prices from an eBay sold/completed search results page (old s-item and new s-card markup). */
export function parseSold(html) {
  const out = [];
  const items = html.split(/<li[^>]+class="[^"]*\bs-(?:item|card)\b/).slice(1);
  for (const it of items) {
    if (/Shop on eBay/i.test(it)) continue;
    const pm = it.match(/class="[^"]*s-(?:item|card)__price[^"]*"[^>]*>([\s\S]*?)<\/span>\s*(?:<\/span>)?/);
    if (!pm) continue;
    const text = pm[1].replace(/<[^>]+>/g, '').trim();
    if (/\bto\b/i.test(text)) continue;
    const p = parsePrice(text);
    if (p != null && p > 0) out.push(p);
  }
  return out;
}

const TWELVE_H = 12 * 3600 * 1000;

export function createCompsFetcher({ db, fetchFn = fetch }) {
  const inflight = new Map();
  return function getSoldPrices(keywords) {
    const k = mainKeywords(keywords).toLowerCase().trim();
    if (!inflight.has(k)) inflight.set(k, lookup(keywords).finally(() => inflight.delete(k)));
    return inflight.get(k);
  };
  async function lookup(keywords) {
    keywords = mainKeywords(keywords);
    const key = 'sold:' + keywords.toLowerCase().trim();
    const cached = db.cacheGet(key, TWELVE_H);
    if (cached) return cached;
    // eBay UK sold listings, UK sellers only (LH_PrefLoc=1).
    const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(keywords)}&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1&_ipg=60`;
    const res = await fetchFn(url, { headers: { 'user-agent': UA, 'accept-language': 'en-GB' } });
    if (!res.ok) throw new Error(`eBay sold comps HTTP ${res.status}`);
    const prices = parseSold(await res.text());
    db.cacheSet(key, prices);
    return prices;
  }
}

export const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/**
 * Everything we know about a deal's value: eBay resale estimate (or your own figure) and CeX prices.
 * bestProfit is the better of eBay resale profit and selling to CeX for cash; score is based on it.
 * refValue is the "usual price" used by the scam check.
 */
export function buildEstimate(search, listing, { prices = null, cex = null, feePct = 0 } = {}) {
  const e = prices || search.resaleOverride != null ? estimate(search, listing, prices || [], { feePct }) : null;
  const price = listing.price;
  const cexPart = cex && price != null && cex.cash != null ? {
    name: cex.name, url: cex.url, sell: cex.sell, cash: cex.cash, voucher: cex.voucher,
    cashProfit: round2(cex.cash - price - (listing.extraCost || 0)),
    voucherProfit: cex.voucher != null ? round2(cex.voucher - price - (listing.extraCost || 0)) : null,
  } : null;
  if (!e && !cexPart) return null;
  const profits = [e?.profit, cexPart?.cashProfit].filter((n) => n != null);
  const bestProfit = Math.max(...profits);
  const base = Math.max(price ?? 0, 1);
  return {
    value: e?.value ?? null,
    profit: e?.profit ?? null,
    comps: e?.comps ?? 0,
    cex: cexPart,
    bestProfit,
    // An automatic CeX match can be the wrong model, so only a pinned CeX item may stand in for
    // eBay prices as the "usual price" the scam check compares against.
    refValue: e?.value ?? (cex?.pinned ? cex.sell : null) ?? null,
    score: Math.max(0, Math.min(100, Math.round((bestProfit / base) * 100))),
  };
}
