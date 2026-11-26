import { parseCards } from './cards.js';
import { scrapeCards } from '../browser.js';

export const id = 'facebook';
export const label = 'Facebook Marketplace';
export const lane = 'browser';
export const minIntervalSec = 45;

export function parse(cards) {
  return parseCards(cards, {
    source: id,
    idPattern: /\/marketplace\/item\/(\d+)/,
    urlFor: (i) => `https://www.facebook.com/marketplace/item/${i}/`,
  });
}

export function buildUrl(search, config) {
  const p = new URLSearchParams({ query: search.keywords, sortBy: 'creation_time_descend', exact: 'false' });
  if (search.minPrice != null) p.set('minPrice', String(search.minPrice));
  if (search.maxPrice != null) p.set('maxPrice', String(search.maxPrice));
  if (search.radius) p.set('radius', String(Math.round(search.radius * 1.609)));
  const loc = search.facebookLocation || config.facebookLocation;
  return `https://www.facebook.com/marketplace/${encodeURIComponent(loc)}/search?${p}`;
}

export async function search(s, ctx) {
  return parse(await scrapeCards(ctx.config, buildUrl(s, ctx.config), 'a[href*="/marketplace/item/"]', { key: id }));
}
