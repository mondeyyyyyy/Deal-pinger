// Seller message helpers, shared by the app (browser) and the server (Telegram alerts).

// Marketplaces where buying normally means meeting the seller and collecting.
export const COLLECTION_SOURCES = ['facebook', 'gumtree'];

export const DEFAULT_TEMPLATE = 'Hi! Is this still available? {collect}Would you take {offer}?';

const COLLECT_WORDS = /\b(collect(?:ion|ed|ing)?|pick[\s-]?up|pickup)\b/i;

/** True when the listing itself talks about collection / pick-up. */
export function mentionsCollection(listing) {
  return COLLECT_WORDS.test(`${listing.title || ''} ${listing.description || ''}`);
}

/** Should a message to this seller talk about collecting? */
export function isCollection(listing) {
  return COLLECTION_SOURCES.includes(listing.source) || mentionsCollection(listing);
}

/** A polite opening offer: about 85% of the asking price, rounded to £5 (or £1 under £20). */
export function offerFor(price) {
  if (price == null || !(price > 0)) return 'a fair price';
  const raw = price * 0.85;
  const step = raw < 20 ? 1 : 5;
  return '£' + Math.max(1, Math.round(raw / step) * step);
}

const money = (n) => (n == null ? '' : '£' + (Number.isInteger(n) ? n : Number(n).toFixed(2)));

/**
 * Fill in a message template for a listing. {collect} becomes "I can collect today. " only when
 * collecting applies; in any other case, sentences that talk about collecting are dropped,
 * so a postage marketplace never gets a collection message.
 */
export function buildMessage(template, listing) {
  const collect = isCollection(listing);
  let tpl = String(template || DEFAULT_TEMPLATE);
  if (!collect) {
    const sentences = tpl.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((s) => !COLLECT_WORDS.test(s));
    if (kept.length !== sentences.length) {
      tpl = kept.join(' ');
      if (/\{offer\}/.test(template) && !/\{offer\}/.test(tpl)) tpl += (tpl ? ' ' : '') + 'Would you take {offer}?';
    }
  }
  return tpl
    .replaceAll('{collect}', collect ? 'I can collect today. ' : '')
    .replaceAll('{title}', listing.title || '')
    .replaceAll('{price}', money(listing.price))
    .replaceAll('{offer}', offerFor(listing.price))
    .replace(/\s{2,}/g, ' ')
    .trim();
}
