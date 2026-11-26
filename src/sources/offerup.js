import { parseCards } from './cards.js';
import { scrapeCards } from '../browser.js';

export const id = 'offerup';
export const label = 'OfferUp';

export function parse(cards) {
  return parseCards(cards, {
    source: id,
    idPattern: /\/item\/detail\/([\w-]+)/,
    urlFor: (i) => `https://offerup.com/item/detail/${i}`,
  });
}

export function buildUrl(search) {
  const p = new URLSearchParams({ q: search.keywords, sort: '-posted' });
  if (search.minPrice != null) p.set('price_min', String(search.minPrice));
  if (search.maxPrice != null) p.set('price_max', String(search.maxPrice));
  if (search.radius) p.set('radius', String(search.radius));
  if (search.zip) p.set('zipcode', search.zip);
  return `https://offerup.com/search?${p}`;
}

export async function search(s, ctx) {
  return parse(await scrapeCards(ctx.config, buildUrl(s), 'a[href*="/item/detail/"]'));
}
