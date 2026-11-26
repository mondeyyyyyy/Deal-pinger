import { parsePrice } from '../match.js';
import { stripTags } from '../net.js';

export const id = 'ebay';
export const label = 'eBay';

/** Parse an eBay Browse API item_summary/search response. */
export function parse(json) {
  return (json.itemSummaries || []).map((it) => {
    const loc = it.itemLocation || {};
    const location = [loc.city, loc.stateOrProvince].filter(Boolean).join(', ') || null;
    const legacy = it.legacyItemId || String(it.itemId).split('|')[1] || it.itemId;
    return {
      source: id,
      id: String(legacy),
      title: it.title,
      price: it.price ? parsePrice(it.price.value) : null,
      url: `https://www.ebay.co.uk/itm/${legacy}`,
      image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
      location,
      postedAt: it.itemCreationDate || null,
    };
  });
}

/** Fallback when no API keys: parse the public search results page (old s-item and new s-card markup). */
export function parseHtml(html) {
  const out = [];
  const items = html.split(/<li[^>]+class="[^"]*\bs-(?:item|card)\b/).slice(1);
  for (const it of items) {
    if (/Shop on eBay/i.test(it)) continue;
    const itemId = it.match(/ebay\.co(?:m|\.uk)\/itm\/(\d+)/)?.[1];
    if (!itemId) continue;
    const title = stripTags(it.match(/class="[^"]*s-(?:item|card)__title[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '').replace(/^New Listing\s*/i, '');
    const priceTxt = stripTags(it.match(/class="[^"]*s-(?:item|card)__price[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '');
    const image = it.match(/<img[^>]+src="([^"]+)"/)?.[1] || null;
    if (!title) continue;
    out.push({ source: id, id: itemId, title, price: /\bto\b/.test(priceTxt) ? null : parsePrice(priceTxt), url: `https://www.ebay.co.uk/itm/${itemId}`, image, location: null, postedAt: null });
  }
  return out;
}

let token = null;
async function getToken(ctx) {
  if (token && token.exp > Date.now() + 60000) return token.value;
  const basic = Buffer.from(`${ctx.config.ebayAppId}:${ctx.config.ebayCertId}`).toString('base64');
  const res = await ctx.fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  if (!res.ok) throw new Error(`eBay auth HTTP ${res.status}`);
  const j = await res.json();
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}

export function buildApiUrl(s) {
  const p = new URLSearchParams({ q: s.keywords, sort: 'newlyListed', limit: '50' });
  const filters = ['buyingOptions:{FIXED_PRICE|BEST_OFFER|AUCTION}', 'itemLocationCountry:GB'];
  if (s.minPrice != null || s.maxPrice != null) {
    filters.push(`price:[${s.minPrice ?? ''}..${s.maxPrice ?? ''}]`, 'priceCurrency:GBP');
  }
  p.set('filter', filters.join(','));
  return `https://api.ebay.com/buy/browse/v1/item_summary/search?${p}`;
}

export async function search(s, ctx) {
  if (ctx.config.ebayAppId && ctx.config.ebayCertId) {
    const headers = { authorization: `Bearer ${await getToken(ctx)}`, 'x-ebay-c-marketplace-id': 'EBAY_GB' };
    if (s.zip) headers['x-ebay-c-enduserctx'] = `contextualLocation=country%3DGB%2Czip%3D${encodeURIComponent(s.zip)}`;
    const res = await ctx.fetch(buildApiUrl(s), { headers });
    if (!res.ok) throw new Error(`eBay API HTTP ${res.status}`);
    return parse(await res.json());
  }
  // LH_PrefLoc=1: UK-only listings. _sop=10: newest first.
  const p = new URLSearchParams({ _nkw: s.keywords, _sop: '10', _ipg: '60', LH_PrefLoc: '1' });
  if (s.minPrice != null) p.set('_udlo', String(s.minPrice));
  if (s.maxPrice != null) p.set('_udhi', String(s.maxPrice));
  const res = await ctx.fetch(`https://www.ebay.co.uk/sch/i.html?${p}`);
  if (!res.ok) throw new Error(`eBay HTTP ${res.status}`);
  return parseHtml(await res.text());
}
