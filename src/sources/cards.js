import { parsePrice } from '../match.js';

const PRICE_LINE = /^(?:free|[A-Z]{0,3}\s?\$\s?[\d,]+(?:\.\d{1,2})?)$/i;

/**
 * Turn raw anchor cards {href, text, img, alt} into Listings.
 * Text lines: the first price-looking line is the price; the remaining lines are title then location.
 */
export function parseCards(cards, { source, idPattern, urlFor, locationLine = true }) {
  const out = [];
  const seen = new Set();
  for (const c of cards || []) {
    const m = String(c.href || '').match(idPattern);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    const lines = String(c.text || '').split('\n').map(s => s.trim()).filter(Boolean);
    const priceIdx = lines.findIndex(l => PRICE_LINE.test(l));
    const price = priceIdx >= 0 ? parsePrice(lines[priceIdx]) : null;
    const rest = lines.filter((l, i) => i !== priceIdx && !PRICE_LINE.test(l));
    const title = rest[0] || String(c.alt || '').replace(/\s+in\s+[^,]+,\s*[A-Z]{2}$/, '').trim();
    if (!title) continue;
    seen.add(id);
    out.push({
      source,
      id,
      title,
      price,
      url: urlFor(id),
      image: c.img || null,
      location: locationLine && rest[1] ? rest[1] : null,
      postedAt: null,
    });
  }
  return out;
}
