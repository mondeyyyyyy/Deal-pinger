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

export function matches(listing, search) {
  const title = String(listing.title || '').toLowerCase();
  if (!words(search.keywords).every(w => title.includes(w))) return false;
  const excluded = String(search.excludeWords || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (excluded.some(w => title.includes(w))) return false;
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
