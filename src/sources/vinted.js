import { parsePrice } from '../match.js';
import { withPage } from '../browser.js';

export const id = 'vinted';
export const label = 'Vinted';
export const lane = 'fetch';
export const minIntervalSec = 20;

const BASE = 'https://www.vinted.co.uk';

/** Parse a Vinted /api/v2/catalog/items response. */
export function parse(json) {
  return (json.items || []).map((it) => {
    const raw = it.price && typeof it.price === 'object' ? it.price.amount : it.price;
    const url = String(it.url || `/items/${it.id}`);
    return {
      source: id,
      id: String(it.id),
      title: [it.title, it.size_title].filter(Boolean).join(' · ') || 'Vinted item',
      price: parsePrice(raw),
      url: url.startsWith('http') ? url : BASE + url,
      image: it.photo?.url || null,
      location: null,
      // The first photo's upload time is effectively when the item was listed.
      postedAt: it.photo?.high_resolution?.timestamp ? new Date(it.photo.high_resolution.timestamp * 1000).toISOString() : null,
    };
  });
}

export function buildApiUrl(s) {
  const p = new URLSearchParams({ page: '1', per_page: '96', search_text: s.keywords, order: 'newest_first' });
  if (s.minPrice != null) p.set('price_from', String(s.minPrice));
  if (s.maxPrice != null) p.set('price_to', String(s.maxPrice));
  p.set('currency', 'GBP');
  return `${BASE}/api/v2/catalog/items?${p}`;
}

// Vinted's API needs the session cookies the homepage hands out. Cache them and refresh on 401/403.
let cookies = null;

async function getCookies(ctx) {
  const res = await ctx.fetch(BASE + '/', { redirect: 'follow' });
  const set = res.headers.getSetCookie?.() || [];
  cookies = set.map((c) => c.split(';')[0]).join('; ');
  if (!cookies) throw new Error(`Vinted gave no session (HTTP ${res.status})`);
  return cookies;
}

async function viaFetch(s, ctx) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = cookies || (await getCookies(ctx));
    const res = await ctx.fetch(buildApiUrl(s), { headers: { cookie, accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) { cookies = null; continue; }
    if (!res.ok) throw new Error(`Vinted HTTP ${res.status}`);
    return parse(await res.json());
  }
  throw new Error('Vinted refused the session');
}

/** Fallback: let a real browser get past bot checks, then call the API from inside the page. */
async function viaBrowser(s, ctx) {
  return withPage(ctx.config, async (page) => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const json = await page.evaluate(async (url) => {
      const r = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'include' });
      if (!r.ok) throw new Error('Vinted HTTP ' + r.status);
      return r.json();
    }, buildApiUrl(s));
    return parse(json);
  }, { key: id });
}

export async function search(s, ctx) {
  try {
    return await viaFetch(s, ctx);
  } catch (e) {
    try {
      return await viaBrowser(s, ctx);
    } catch (e2) {
      throw new Error(`${e.message}; browser fallback: ${e2.message}`);
    }
  }
}
