import { mainKeywords } from './match.js';

// CeX (uk.webuy.com) prices: what CeX sells an item for, and what it pays in cash or voucher.

const API = 'https://wss2.cex.uk.webuy.io/v3';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function productUrl(id) {
  return `https://uk.webuy.com/product-detail?id=${encodeURIComponent(id)}`;
}

function toBox(b) {
  const id = String(b.boxId ?? b.id ?? '');
  if (!id) return null;
  return {
    id,
    name: String(b.boxName ?? b.name ?? ''),
    category: b.categoryFriendlyName ?? b.categoryName ?? null,
    sell: num(b.sellPrice),
    cash: num(b.cashPrice),
    voucher: num(b.exchangePrice),
    image: b.imageUrls?.medium || b.imageUrls?.large || b.boxImageUrl || null,
    url: productUrl(id),
  };
}

/** Parse a CeX /boxes search response. */
export function parseBoxes(json) {
  const boxes = json?.response?.data?.boxes;
  return Array.isArray(boxes) ? boxes.map(toBox).filter(Boolean) : [];
}

/** Parse a CeX /boxes/{id}/detail response. */
export function parseDetail(json) {
  const d = json?.response?.data?.boxDetails?.[0];
  return d ? toBox(d) : null;
}

const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The CeX item that best fits the keywords: its name must contain every keyword, and among those
 * the one with the fewest extra words wins ("iPhone 13 128GB" beats "iPhone 13 Pro Max 1TB").
 */
export function bestMatch(boxes, keywords) {
  const words = String(keywords || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let best = null;
  let bestExtra = Infinity;
  for (const b of boxes) {
    if (b.cash == null || !words.every((w) => b.name.toLowerCase().includes(w))) continue;
    const extra = tokens(b.name).filter((t) => !words.some((w) => w.includes(t) || t.includes(w))).length;
    if (extra < bestExtra) { best = b; bestExtra = extra; }
  }
  return best;
}

export function createCex({ db, fetchFn }) {
  // Same lookup requested twice at once (pre-load + alert) shares one request.
  const inflight = new Map();

  async function getJson(url) {
    const res = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`CeX HTTP ${res.status}`);
    const json = await res.json();
    // CeX wraps errors (rate limits, maintenance) in a 200 response: treat them as failures, not "no match".
    if (!json?.response || (json.response.ack && json.response.ack !== 'Success') || !json.response.data) {
      throw new Error(`CeX error: ${json?.response?.error?.internal_message || json?.response?.ack || 'unexpected reply'}`);
    }
    return json;
  }

  async function search(q, count = 10) {
    const p = new URLSearchParams({ q, firstRecord: '1', count: String(count), sortOrder: 'desc' });
    return parseBoxes(await getJson(`${API}/boxes?${p}`));
  }

  async function box(id) {
    return parseDetail(await getJson(`${API}/boxes/${encodeURIComponent(id)}/detail`));
  }

  /**
   * CeX prices for a search: its pinned CeX item, else the best automatic match.
   * Prices are cached for a day; "nothing matched" only for an hour; errors aren't cached.
   * The result says whether it was pinned, because only a pinned item is trusted as a scam reference.
   */
  async function forSearch(s) {
    if (s.cexMode === 'off') return null;
    const kw = mainKeywords(s.keywords);
    const key = s.cexBoxId ? `cex:id:${s.cexBoxId}` : `cex:q:${kw.toLowerCase().trim()}`;
    const cached = db.cacheGet(key, DAY);
    if (cached !== undefined && (cached !== null || db.cacheGet(key, HOUR) !== undefined)) return withPin(cached, s);
    if (inflight.has(key)) return withPin(await inflight.get(key), s);
    const p = (async () => {
      const result = s.cexBoxId ? await box(s.cexBoxId) : bestMatch(await search(kw, 20), kw);
      db.cacheSet(key, result);
      return result;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return withPin(await p, s);
  }

  const withPin = (b, s) => (b ? { ...b, pinned: !!s.cexBoxId } : null);

  return { search, box, forSearch };
}
