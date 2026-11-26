import { parsePrice } from '../match.js';
import { stripTags, decodeEntities } from '../net.js';

export const id = 'craigslist';
export const label = 'Craigslist';

export function parse(html) {
  const out = [];
  const blocks = html.split(/<li[^>]+class="[^"]*cl-static-search-result[^"]*"/).slice(1);
  for (const b of blocks) {
    const href = b.match(/href="([^"]+)"/)?.[1];
    const pid = href?.match(/\/(\d+)\.html/)?.[1];
    if (!pid) continue;
    const titleAttr = b.match(/^[^>]*title="([^"]*)"/)?.[1];
    const title = titleAttr ? decodeEntities(titleAttr) : stripTags(b.match(/class="title"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '');
    const priceTxt = stripTags(b.match(/class="price"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '');
    const loc = stripTags(b.match(/class="location"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '');
    out.push({ source: id, id: pid, title, price: parsePrice(priceTxt), url: decodeEntities(href), image: null, location: loc || null, postedAt: null });
  }
  return out;
}

export function buildUrl(search, config) {
  const p = new URLSearchParams({ query: search.keywords, sort: 'date' });
  if (search.zip) p.set('postal', search.zip);
  if (search.zip && search.radius) p.set('search_distance', String(search.radius));
  if (search.minPrice != null) p.set('min_price', String(search.minPrice));
  if (search.maxPrice != null) p.set('max_price', String(search.maxPrice));
  const site = search.craigslistSite || config.craigslistSite;
  return `https://${site}.craigslist.org/search/sss?${p}`;
}

export async function search(s, ctx) {
  const res = await ctx.fetch(buildUrl(s, ctx.config));
  if (!res.ok) throw new Error(`Craigslist HTTP ${res.status}`);
  return parse(await res.text());
}
