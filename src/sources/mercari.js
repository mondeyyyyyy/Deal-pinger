import { parseCards } from './cards.js';
import { scrapeCards } from '../browser.js';

export const id = 'mercari';
export const label = 'Mercari';

export function parse(cards) {
  return parseCards(cards, {
    source: id,
    idPattern: /\/item\/(m\d+)/,
    urlFor: (i) => `https://www.mercari.com/us/item/${i}/`,
    locationLine: false,
  });
}

export function buildUrl(search) {
  // Mercari price filters are in cents; sortBy=2 = newest first.
  const p = new URLSearchParams({ keyword: search.keywords, sortBy: '2', status: 'on_sale' });
  if (search.minPrice != null) p.set('minPrice', String(Math.round(search.minPrice * 100)));
  if (search.maxPrice != null) p.set('maxPrice', String(Math.round(search.maxPrice * 100)));
  return `https://www.mercari.com/search/?${p}`;
}

export async function search(s, ctx) {
  return parse(await scrapeCards(ctx.config, buildUrl(s), 'a[href*="/item/m"]'));
}
