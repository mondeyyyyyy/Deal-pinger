import { parsePrice } from './match.js';

export const EBAY_FEE = 0.1325;

export function median(nums) {
  const a = nums.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const round2 = (n) => Math.round(n * 100) / 100;

export function estimate(search, listing, soldPrices) {
  const value = median(soldPrices || []);
  if (value == null || listing.price == null) return null;
  const profit = round2(value * (1 - EBAY_FEE) - (search.shipEstimate ?? 12) - listing.price);
  const base = Math.max(listing.price, 1);
  const score = Math.max(0, Math.min(100, Math.round((profit / base) * 100)));
  return { value: round2(value), profit, score, comps: soldPrices.length };
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
  return async function getSoldPrices(keywords) {
    const key = 'sold:' + keywords.toLowerCase().trim();
    const cached = db.cacheGet(key, TWELVE_H);
    if (cached) return cached;
    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keywords)}&LH_Sold=1&LH_Complete=1&_ipg=60`;
    const res = await fetchFn(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US' } });
    if (!res.ok) throw new Error(`eBay sold comps HTTP ${res.status}`);
    const prices = parseSold(await res.text());
    db.cacheSet(key, prices);
    return prices;
  };
}

export const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
