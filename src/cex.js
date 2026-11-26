import { mainKeywords } from './match.js';

// CeX (uk.webuy.com) prices: what CeX sells an item for, and what it pays in cash or voucher.

const API = 'https://wss2.cex.uk.webuy.io/v3';
const DAY = 24 * 3600 * 1000;

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

/** The first (most relevant) box whose name contains every keyword; null if none does. */
export function bestMatch(boxes, keywords) {
  const words = String(keywords || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return boxes.find((b) => b.cash != null && words.every((w) => b.name.toLowerCase().includes(w))) || null;
}

export function createCex({ db, fetchFn }) {
  async function getJson(url) {
    const res = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`CeX HTTP ${res.status}`);
    return res.json();
  }

  async function search(q, count = 10) {
    const p = new URLSearchParams({ q, firstRecord: '1', count: String(count), sortOrder: 'desc' });
    return parseBoxes(await getJson(`${API}/boxes?${p}`));
  }

  async function box(id) {
    return parseDetail(await getJson(`${API}/boxes/${encodeURIComponent(id)}/detail`));
  }

  /** CeX prices for a search: its pinned CeX item, else the best automatic match. Cached for a day. */
  async function forSearch(s) {
    if (s.cexMode === 'off') return null;
    const kw = mainKeywords(s.keywords);
    const key = s.cexBoxId ? `cex:id:${s.cexBoxId}` : `cex:q:${kw.toLowerCase().trim()}`;
    const cached = db.cacheGet(key, DAY);
    if (cached !== undefined) return cached;
    const result = s.cexBoxId ? await box(s.cexBoxId) : bestMatch(await search(kw, 20), kw);
    db.cacheSet(key, result);
    return result;
  }

  return { search, box, forSearch };
}
