export function parsePrice(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^free$/i.test(s)) return 0;
  const m = s.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

const words = (s) => String(s || '').toLowerCase().split(/\s+/).filter(Boolean);

/** "ps5 | playstation 5" → ['ps5', 'playstation 5']: a search can cover several ways of naming an item. */
export function keywordVariants(keywords) {
  return String(keywords || '').split('|').map(s => s.trim()).filter(Boolean);
}

/** The first variant: used for eBay sold prices and CeX matching. */
export const mainKeywords = (keywords) => keywordVariants(keywords)[0] || '';

// "WANTED: PS5" posts are buyers, and swap-only listings aren't for sale.
const NOT_FOR_SALE = /^\W*(wanted|wtb|looking for|iso|in search of)\b|\b(swaps?|trades?) only\b/i;

export function matches(listing, search) {
  const title = String(listing.title || '').toLowerCase();
  if (NOT_FOR_SALE.test(title)) return false;
  const variants = keywordVariants(search.keywords);
  if (!variants.some(v => words(v).every(w => title.includes(w)))) return false;
  // Skip words match whole words/phrases, so "locked" doesn't hide "unlocked" and "case" doesn't hide "showcase".
  const excluded = String(search.excludeWords || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (excluded.some(w => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?($|[^a-z0-9])`).test(title))) return false;
  const p = listing.price;
  if (p != null) {
    if (search.minPrice != null && p < search.minPrice) return false;
    if (search.maxPrice != null && p > search.maxPrice) return false;
  }
  return true;
}

/** now: "HH:MM" in the user's timezone. */
export function inQuietHours({ quietStart, quietEnd }, now) {
  if (!quietStart || !quietEnd) return false;
  if (quietStart <= quietEnd) return now >= quietStart && now < quietEnd;
  return now >= quietStart || now < quietEnd;
}

export function nowHHMM(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
