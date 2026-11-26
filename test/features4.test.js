import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, DEFAULT_TEMPLATE, offerFor } from '../public/messages.js';
import { assessScam } from '../src/scam.js';
import { parseBoxes, bestMatch } from '../src/cex.js';
import { buildEstimate } from '../src/comps.js';

const L = (source, title, price = 100, extra = {}) => ({ source, id: '1', title, price, url: 'https://x', image: null, location: null, postedAt: null, ...extra });

// ---------- messages ----------
test('collection is mentioned for local marketplaces', () => {
  const m = buildMessage(DEFAULT_TEMPLATE, L('facebook', 'PS5 console', 200));
  assert.match(m, /collect/i);
  assert.match(m, /£170/);
  assert.match(buildMessage(DEFAULT_TEMPLATE, L('gumtree', 'PS5')), /collect/i);
});

test('collection is not mentioned for postage marketplaces unless the listing says so', () => {
  for (const src of ['vinted', 'ebay', 'depop']) assert.doesNotMatch(buildMessage(DEFAULT_TEMPLATE, L(src, 'PS5 console')), /collect|pick ?up/i, src);
  assert.match(buildMessage(DEFAULT_TEMPLATE, L('ebay', 'PS5 console - collection only')), /collect/i);
  assert.match(buildMessage(DEFAULT_TEMPLATE, L('vinted', 'Bike, local pick up only')), /collect/i);
});

test('old and custom templates have collection sentences removed where they do not apply', () => {
  const old = 'Hi! Is this still available? I can collect today for {offer}.';
  const m = buildMessage(old, L('vinted', 'Switch Lite', 80));
  assert.doesNotMatch(m, /collect/i);
  assert.match(m, /£70/);
  const custom = 'Hiya, still for sale? Happy to pick up tonight. Would you do {offer}?';
  assert.equal(buildMessage(custom, L('depop', 'Jacket', 40)), 'Hiya, still for sale? Would you do £35?');
  assert.equal(buildMessage(custom, L('facebook', 'Jacket', 40)), 'Hiya, still for sale? Happy to pick up tonight. Would you do £35?');
});

test('offer is about 85% rounded to £5 (or £1 under £20)', () => {
  assert.equal(offerFor(200), '£170');
  assert.equal(offerFor(12), '£10');
  assert.equal(offerFor(null), 'a fair price');
});

// ---------- scam ----------
test('new seller with no ratings selling a valuable item far too cheap is high risk', () => {
  const r = assessScam(L('vinted', 'iPhone 15 Pro', 150, { seller: { ratings: 0 } }), { value: 650 });
  assert.equal(r.risk, 'high');
  assert.ok(r.reasons.some(x => /no ratings/i.test(x)));
  assert.ok(r.reasons.some(x => /below/i.test(x)));
});

test('established seller with a fair price is low risk', () => {
  assert.equal(assessScam(L('ebay', 'iPhone 15 Pro', 560, { seller: { ratings: 340 } }), { value: 650 }).risk, 'low');
});

test('payment red flags', () => {
  const r = assessScam(L('facebook', 'PS5 brand new, bank transfer only, whatsapp me', 300), { value: 380 });
  assert.equal(r.risk, 'medium');
  assert.equal(assessScam(L('facebook', 'PS5 paypal friends and family only', 120), { value: 380 }).risk, 'high');
});

test('absurdly cheap expensive item is high risk even without seller info', () => {
  assert.equal(assessScam(L('facebook', 'MacBook Pro M3', 150), { value: 1200 }).risk, 'high');
  assert.equal(assessScam(L('facebook', 'MacBook Pro M3', 700), { value: 1200 }).risk, 'low');
});

test('cheap items and unknown values are not flagged on price alone', () => {
  assert.equal(assessScam(L('vinted', 'T-shirt', 3), { value: 20 }).risk, 'low');
  assert.equal(assessScam(L('vinted', 'Mystery thing', 3), { value: null }).risk, 'low');
});

test('brand-new account counts like no ratings', () => {
  const joined = new Date(Date.now() - 5 * 86400000).toISOString();
  assert.equal(assessScam(L('ebay', 'AirPods Pro 2', 60, { seller: { ratings: 2, joinedAt: joined } }), { value: 150 }).risk, 'high');
});

// ---------- CeX ----------
const cexJson = { response: { ack: 'Success', data: { boxes: [
  { boxId: '711719521290', boxName: 'Playstation 5 Console, Disc, 825GB, White, Unboxed', categoryFriendlyName: 'Playstation5 Consoles', sellPrice: 330, cashPrice: 205, exchangePrice: 250, imageUrls: { medium: 'https://uk.static.webuy.com/a.jpg' } },
  { boxId: '711719541076', boxName: 'Playstation 5 Console, Digital, 825GB, White, Boxed', categoryFriendlyName: 'Playstation5 Consoles', sellPrice: 300, cashPrice: 180, exchangePrice: 225 },
  { boxId: 'SPS5GTA', boxName: 'GTA V (PS5)', categoryFriendlyName: 'Playstation5 Software', sellPrice: 15, cashPrice: 6, exchangePrice: 9 },
] } } };

test('CeX boxes parse into sell/cash/voucher prices with a product link', () => {
  const b = parseBoxes(cexJson);
  assert.equal(b.length, 3);
  assert.deepEqual({ ...b[0], image: undefined }, { id: '711719521290', name: 'Playstation 5 Console, Disc, 825GB, White, Unboxed', category: 'Playstation5 Consoles', sell: 330, cash: 205, voucher: 250, image: undefined, url: 'https://uk.webuy.com/product-detail?id=711719521290' });
  assert.deepEqual(parseBoxes({}), []);
});

test('CeX best match needs every keyword', () => {
  const b = parseBoxes(cexJson);
  assert.equal(bestMatch(b, 'ps5 digital')?.id ?? null, null); // "ps5" isn't in the console names
  assert.equal(bestMatch(b, 'playstation 5 digital').id, '711719541076');
  assert.equal(bestMatch(b, 'playstation 5').id, '711719521290');
  assert.equal(bestMatch(b, 'xbox'), null);
});

// ---------- combined estimate ----------
test('estimate combines eBay resale and CeX cash, scoring on the better one', () => {
  const cex = { name: 'PS5 Disc', sell: 330, cash: 205, voucher: 250, url: 'https://uk.webuy.com/product-detail?id=1' };
  const e = buildEstimate({ shipEstimate: 4 }, L('facebook', 'ps5', 150), { prices: [260], cex, feePct: 0 });
  assert.equal(e.profit, 106);
  assert.equal(e.cex.cashProfit, 55);
  assert.equal(e.cex.voucherProfit, 100);
  assert.equal(e.bestProfit, 106);
  const onlyCex = buildEstimate({ shipEstimate: 4 }, L('facebook', 'ps5', 150), { prices: null, cex: { ...cex, pinned: true }, feePct: 0 });
  assert.equal(onlyCex.profit, null);
  assert.equal(onlyCex.bestProfit, 55);
  assert.equal(onlyCex.refValue, 330);
  assert.equal(buildEstimate({ shipEstimate: 4 }, L('facebook', 'ps5', 150), { prices: [], cex: null }), null);
});

test('high-value item at around £80 from a brand-new account with no history is a likely scam', () => {
  const fresh = { ratings: 0 };
  const r = assessScam(L('vinted', 'AirPods Max', 80, { seller: fresh }), { value: 150 });
  assert.equal(r.risk, 'high');
  assert.ok(r.reasons.some(x => /£80 for a £150 item/.test(x)), r.reasons.join('|'));
  const joined = new Date(Date.now() - 3 * 86400000).toISOString();
  assert.equal(assessScam(L('ebay', 'Switch OLED', 95, { seller: { ratings: 1, joinedAt: joined } }), { value: 220 }).risk, 'high');
  // not when the seller has a track record, the item isn't high value, or the price is fair
  assert.notEqual(assessScam(L('vinted', 'AirPods Max', 80, { seller: { ratings: 40 } }), { value: 150 }).risk, 'high');
  assert.equal(assessScam(L('vinted', 'Jumper', 80, { seller: fresh }), { value: 100 }).risk, 'low');
  assert.notEqual(assessScam(L('vinted', 'Coat', 120, { seller: fresh }), { value: 150 }).risk, 'high'); // 80% of value: fair
});
