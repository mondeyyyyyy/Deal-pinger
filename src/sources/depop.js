import { parseCards } from './cards.js';
import { scrapeCards } from '../browser.js';

export const id = 'depop';
export const label = 'Depop';

/** "vintageking-nike-air-max-90-trainers-uk9-5f2a" -> "Nike Air Max 90 Trainers Uk9" (drops seller name and short hash). */
export function titleFromSlug(slug) {
  const parts = String(slug).split('-').filter(Boolean).slice(1);
  if (parts.length > 1 && /^[0-9a-f]{4}$/.test(parts.at(-1)) && /\d/.test(parts.at(-1))) parts.pop();
  return parts.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export function parse(cards) {
  return parseCards(cards, {
    source: id,
    idPattern: /\/products\/([\w-]+)/,
    urlFor: (slug) => `https://www.depop.com/products/${slug}/`,
    locationLine: false,
    // Depop cards show price + size, not the title; use the image alt text or the descriptive URL.
    titleFor: (c, m) => String(c.alt || '').trim() || titleFromSlug(m[1]),
  });
}

export function buildUrl(search) {
  const p = new URLSearchParams({ q: search.keywords, sort: 'newlyListed' });
  if (search.minPrice != null) p.set('priceMin', String(search.minPrice));
  if (search.maxPrice != null) p.set('priceMax', String(search.maxPrice));
  return `https://www.depop.com/search/?${p}`;
}

export async function search(s, ctx) {
  return parse(await scrapeCards(ctx.config, buildUrl(s), 'a[href*="/products/"]'));
}
