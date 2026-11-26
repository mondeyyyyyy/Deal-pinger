import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, DEFAULT_TEMPLATE } from '../public/messages.js';
import { openDb } from '../src/db.js';
import { createCex, bestMatch, parseBoxes } from '../src/cex.js';
import { buildEstimate } from '../src/comps.js';
import { runSourceOnce } from '../src/poller.js';
import { createNotifier } from '../src/notify.js';

const L = (source, title, price = 100, extra = {}) => ({ source, id: '1', title, price, url: 'https://x', image: null, location: null, postedAt: null, ...extra });

test('R1: "collection" as a noun, or "no collection", never triggers collect wording', () => {
  for (const t of ['Pokemon card collection', 'Vinyl record collection 50 LPs', 'PS5 - postage only, no collection', 'Lego collection, will post'])
    assert.doesNotMatch(buildMessage(DEFAULT_TEMPLATE, L('vinted', t)), /collect today/i, t);
  for (const t of ['PS5 collection only', 'Bike - collect from Leeds', 'Sofa, pick up only', 'pickup only please', 'Can collect in person'])
    assert.match(buildMessage(DEFAULT_TEMPLATE, L('ebay', t)), /collect today/i, t);
  assert.doesNotMatch(buildMessage(DEFAULT_TEMPLATE, L('facebook', 'Desk, postage only, no collection')), /collect today/i);
});

const boxes = parseBoxes({ response: { ack: 'Success', data: { boxes: [
  { boxId: 'A', boxName: 'Apple iPhone 13 Pro Max 1TB Graphite, Unlocked B', sellPrice: 750, cashPrice: 500, exchangePrice: 600 },
  { boxId: 'B', boxName: 'Apple iPhone 13 128GB Midnight, Unlocked B', sellPrice: 330, cashPrice: 200, exchangePrice: 250 },
] } } });

test('R2: CeX auto-match prefers the closest name, not the first containing the words', () => {
  assert.equal(bestMatch(boxes, 'iphone 13').id, 'B');
});

test('R2: an automatic CeX match alone never makes a listing a high-risk scam', () => {
  const e = buildEstimate({ shipEstimate: 4 }, L('vinted', 'iphone 13', 220), { prices: null, cex: { ...boxes[0], pinned: false } });
  assert.equal(e.refValue, null); // only pinned CeX items (or eBay comps) set the scam reference
  const pinned = buildEstimate({ shipEstimate: 4 }, L('vinted', 'iphone 13', 220), { prices: null, cex: { ...boxes[1], pinned: true } });
  assert.equal(pinned.refValue, 330);
});

test('R3: a CeX failure envelope is not cached as "no match"; a real no-match is cached briefly', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  let reply = { response: { ack: 'Failure', data: null } };
  const cex = createCex({ db, fetchFn: async () => { calls++; return { ok: true, json: async () => reply }; } });
  await assert.rejects(cex.forSearch({ keywords: 'ps5' }));
  reply = { response: { ack: 'Success', data: { boxes: [] } } };
  assert.equal(await cex.forSearch({ keywords: 'ps5' }), null);
  assert.equal(await cex.forSearch({ keywords: 'ps5' }), null);
  assert.equal(calls, 2); // the no-match is cached
  db.raw.prepare("UPDATE cache SET at = at - 2 * 3600 * 1000").run();
  await cex.forSearch({ keywords: 'ps5' });
  assert.equal(calls, 3); // ...but only for about an hour
});

test('R4: no Buy now in Discord or Telegram for a high-risk listing', async () => {
  const db = openDb(':memory:');
  db.setSettings({ discordWebhook: 'https://discord.com/api/webhooks/1/x', telegramBotToken: '1:A', telegramChatId: '2' });
  const posts = [];
  const notify = createNotifier({ db, config: {}, webpush: { setVapidDetails() {} }, now: () => '12:00', log: {}, fetchFn: async (u, o) => { posts.push(o.body); return { ok: true }; } });
  await notify({ name: 's' }, { id: 1, listing: L('ebay', 'PS5', 50, { buyUrl: 'https://pay.ebay.co.uk/rxo?item=1', scam: { risk: 'high', reasons: ['x'] } }), estimate: null });
  assert.equal(posts.length, 2);
  for (const p of posts) assert.doesNotMatch(p, /Buy now/);
});

test('R5: seller lookups run in parallel, and a failed lookup on a far-too-cheap listing is cautious', async () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'iphone', sources: ['v'] });
  let feed = [L('v', 'iphone', 600, { id: 'seed' })];
  const sent = [];
  let active = 0, maxActive = 0;
  const deps = { db, ctx: {}, getSoldPrices: async () => [650], notify: async (_s, h) => sent.push(h), sources: { v: {
    search: async () => feed,
    sellerInfo: async (l) => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 30)); active--; if (l.id === 'fail') throw new Error('x'); return { ratings: 20 }; },
  } } };
  await runSourceOnce(s, 'v', deps);
  feed = [feed[0], ...['a', 'b', 'c', 'fail'].map(id => L('v', 'iphone', 250, { id }))];
  await runSourceOnce(s, 'v', deps);
  assert.ok(maxActive > 1);
  const failed = db.recentHits().find(h => h.listing.id === 'fail');
  assert.notEqual(failed.listing.scam.risk, 'low');
  assert.ok(failed.listing.scam.reasons.some(r => /couldn.t check the seller/i.test(r)));
});

import * as vinted from '../src/sources/vinted.js';
import * as ebay from '../src/sources/ebay.js';

test('M: Vinted only switches to the browser for real blocking (401/403/429), not a server error', async () => {
  vinted._resetForTests();
  let browser = 0;
  const ctx = { config: {}, inLane: async (_l, fn) => fn(),
    withPage: async (_c, fn) => { browser++; return fn({ goto: async () => {}, evaluate: async () => ({ status: 200, body: { items: [] } }) }); },
    fetch: async (url) => url.endsWith('/') ? { ok: true, status: 200, headers: { getSetCookie: () => ['a=b'] } } : { ok: false, status: 503 } };
  await assert.rejects(vinted.search({ keywords: 'x' }, ctx), /503/);
  assert.equal(browser, 0);
  ctx.fetch = async (url) => url.endsWith('/') ? { ok: true, status: 200, headers: { getSetCookie: () => ['a=b'] } } : { ok: false, status: 429 };
  await vinted.search({ keywords: 'x' }, ctx);
  assert.equal(browser, 1);
});

test('M: Vinted checks slow down as more searches use it; reserved items are skipped', () => {
  assert.equal(vinted.minIntervalSec({ searchCount: 1 }), 15);
  assert.equal(vinted.minIntervalSec({ searchCount: 10 }), 30);
  const ls = vinted.parse({ items: [{ id: 1, title: 'a', price: '5', url: '/items/1' }, { id: 2, title: 'b', price: '5', url: '/items/2', is_reserved: true }] });
  assert.deepEqual(ls.map(l => l.id), ['1']);
});

test('M: eBay auction with Buy It Now is labelled', () => {
  const [l] = ebay.parse({ itemSummaries: [{ itemId: 'v1|5|0', legacyItemId: '5', title: 'PS5', price: { value: '300' }, buyingOptions: ['AUCTION', 'FIXED_PRICE'] }] });
  assert.match(l.title, /auction/i);
  assert.ok(l.buyUrl);
});
