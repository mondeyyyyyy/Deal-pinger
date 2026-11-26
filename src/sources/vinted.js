import { parsePrice } from '../match.js';
import { withPage } from '../browser.js';

export const id = 'vinted';
export const label = 'Vinted';
export const lane = 'fetch';
// Every 15s at most; with many Vinted searches, spread out to roughly 20 requests a minute in total.
export function minIntervalSec({ searchCount = 1 } = {}) {
  return Math.max(15, Math.ceil(searchCount * 3));
}

const BASE = 'https://www.vinted.co.uk';

/** Parse a Vinted /api/v2/catalog/items response. */
export function parse(json) {
  // Reserved or sold items can't be bought, so they're not deals.
  return (json.items || []).filter((it) => !it.is_reserved && !it.is_closed && !it.is_sold).map((it) => {
    const raw = it.price && typeof it.price === 'object' ? it.price.amount : it.price;
    const url = String(it.url || `/items/${it.id}`);
    const price = parsePrice(raw);
    const totalRaw = it.total_item_price && typeof it.total_item_price === 'object' ? it.total_item_price.amount : it.total_item_price;
    const total = parsePrice(totalRaw);
    const listing = {
      source: id,
      id: String(it.id),
      title: [it.title, it.size_title].filter(Boolean).join(' · ') || 'Vinted item',
      price,
      url: url.startsWith('http') ? url : BASE + url,
      image: it.photo?.url || null,
      location: null,
      // The first photo's upload time is effectively when the item was listed.
      postedAt: it.photo?.high_resolution?.timestamp ? new Date(it.photo.high_resolution.timestamp * 1000).toISOString() : null,
      buyUrl: `${BASE}/transaction/buy/new?source_screen=item&transaction%5Bitem_id%5D=${it.id}`,
    };
    // Vinted adds a buyer protection fee on top of the price; count it as part of the cost.
    if (price != null && total != null && total > price) listing.extraCost = Math.round((total - price) * 100) / 100;
    if (it.user?.id != null) {
      listing.sellerId = String(it.user.id);
      listing.sellerName = it.user.login ?? null;
    }
    return listing;
  });
}

/** Description and seller ratings for a new deal (one request, only for listings about to alert). */
export async function details(listing, ctx) {
  const cookie = cookies || (await getCookies(ctx));
  const res = await ctx.fetch(`${BASE}/api/v2/items/${encodeURIComponent(listing.id)}`, { headers: { cookie, accept: 'application/json' } });
  if (!res.ok) return null;
  const it = (await res.json())?.item;
  if (!it) return null;
  const out = { description: it.description ?? null };
  if (it.user && it.user.feedback_count != null) out.seller = { name: it.user.login ?? null, ratings: Number(it.user.feedback_count) };
  return out;
}

/** Seller ratings, used by the scam check on suspiciously cheap listings. */
export async function sellerInfo(listing, ctx) {
  if (!listing.sellerId) return null;
  const cookie = cookies || (await getCookies(ctx));
  const res = await ctx.fetch(`${BASE}/api/v2/users/${encodeURIComponent(listing.sellerId)}`, { headers: { cookie, accept: 'application/json' } });
  if (!res.ok) return null;
  const u = (await res.json())?.user;
  if (!u) return null;
  return {
    name: u.login ?? listing.sellerName ?? null,
    ratings: u.feedback_count != null ? Number(u.feedback_count) : null,
    sold: u.given_item_count != null ? Number(u.given_item_count) : null,
    joinedAt: u.created_at ?? null,
  };
}

export function buildApiUrl(s) {
  const p = new URLSearchParams({ page: '1', per_page: '96', search_text: s.keywords, order: 'newest_first' });
  if (s.minPrice != null) p.set('price_from', String(s.minPrice));
  if (s.maxPrice != null) p.set('price_to', String(s.maxPrice));
  p.set('currency', 'GBP');
  return `${BASE}/api/v2/catalog/items?${p}`;
}

const blocked = (msg) => Object.assign(new Error(msg), { blocked: true });

// Vinted's API needs the session cookies the homepage hands out. Cache them and refresh on 401/403.
let cookies = null;

async function getCookies(ctx) {
  const res = await ctx.fetch(BASE + '/', { redirect: 'follow' });
  const set = res.headers.getSetCookie?.() || [];
  cookies = set.map((c) => c.split(';')[0]).join('; ');
  if (!cookies) throw blocked(`Vinted gave no session (HTTP ${res.status})`);
  return cookies;
}

async function viaFetch(s, ctx) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = cookies || (await getCookies(ctx));
    const res = await ctx.fetch(buildApiUrl(s), { headers: { cookie, accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) { cookies = null; continue; }
    if (res.status === 429) throw blocked('Vinted is rate-limiting us (HTTP 429)');
    if (!res.ok) throw new Error(`Vinted HTTP ${res.status}`);
    return parse(await res.json());
  }
  throw blocked('Vinted refused the session');
}

// When the plain API call is blocked, use the browser for a while instead of failing first every time.
const BLOCKED_FOR_MS = 10 * 60 * 1000;
let fetchBlockedUntil = 0;
let browserWarm = false; // the warm browser context already holds Vinted's cookies

export function _resetForTests() { cookies = null; fetchBlockedUntil = 0; browserWarm = false; }

function timeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); })])
    .finally(() => clearTimeout(t));
}

/**
 * Fallback: let a real browser get past bot checks, then call the API from inside the page.
 * Runs in the browser lane so it shares the page limit with Facebook, Gumtree and Depop.
 */
async function viaBrowser(s, ctx) {
  const open = ctx.withPage || withPage;
  const inLane = ctx.inLane || ((_lane, fn) => fn());
  return inLane('browser', () => open(ctx.config, async (page) => {
    const call = (url) => page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { accept: 'application/json' }, credentials: 'include' });
      return { status: r.status, body: r.ok ? await r.json() : null };
    }, url);
    // Once the context has Vinted's cookies, a tiny same-site page is enough to call the API from.
    await page.goto(browserWarm ? BASE + '/robots.txt' : BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    let r = await timeout(call(buildApiUrl(s)), 20000, 'Vinted');
    if (r.status === 401 || r.status === 403) {
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      r = await timeout(call(buildApiUrl(s)), 20000, 'Vinted');
    }
    if (!r.body) { browserWarm = false; throw new Error(`Vinted HTTP ${r.status}`); }
    browserWarm = true;
    return parse(r.body);
  }, { key: id }));
}

export async function search(s, ctx) {
  if (Date.now() < fetchBlockedUntil) return viaBrowser(s, ctx);
  try {
    return await viaFetch(s, ctx);
  } catch (e) {
    // A blip (timeout, 5xx) just fails this check; only real blocking moves Vinted to the browser.
    if (!e.blocked) throw e;
    fetchBlockedUntil = Date.now() + BLOCKED_FOR_MS;
    try {
      return await viaBrowser(s, ctx);
    } catch (e2) {
      throw new Error(`${e.message}; browser fallback: ${e2.message}`);
    }
  }
}
