import { parseCards } from './cards.js';
import { scrapeCards } from '../browser.js';

export const id = 'gumtree';
export const label = 'Gumtree';
export const lane = 'browser';
export const minIntervalSec = 45;

// Listing links look like /p/<category>/<slug>/<numeric id>
const ITEM = /^(?:https:\/\/www\.gumtree\.com)?(\/p\/[^/?#]+\/[^/?#]+\/(\d+))/;

export function parse(cards) {
  return parseCards(cards, {
    source: id,
    idPattern: /^(?:https:\/\/www\.gumtree\.com)?\/p\/[^/?#]+\/[^/?#]+\/(\d+)/,
    urlFor: (_i, c) => 'https://www.gumtree.com' + String(c.href).match(ITEM)[1],
  });
}

export function buildUrl(search) {
  const p = new URLSearchParams({ search_category: 'all', q: search.keywords, sort: 'date' });
  if (search.zip) p.set('search_location', search.zip);
  if (search.zip && search.radius) p.set('distance', String(search.radius));
  if (search.minPrice != null) p.set('min_price', String(search.minPrice));
  if (search.maxPrice != null) p.set('max_price', String(search.maxPrice));
  return `https://www.gumtree.com/search?${p}`;
}

export async function search(s, ctx) {
  return parse(await scrapeCards(ctx.config, buildUrl(s), 'a[href*="/p/"]', { key: id }));
}
