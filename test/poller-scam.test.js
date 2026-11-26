import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSourceOnce } from '../src/poller.js';

const L = (id, price, title = 'iphone 15 pro', extra = {}) => ({ source: 'v', id, title, price, url: 'https://x/' + id, image: null, location: null, postedAt: null, ...extra });

function setup({ sellerRatings = 0, filter } = {}) {
  const db = openDb(':memory:');
  if (filter) db.setSettings({ scamFilter: filter });
  const s = db.addSearch({ name: 'iPhones', keywords: 'iphone 15 pro', sources: ['v'] });
  let feed = [L('seed', 600)];
  let sellerCalls = 0;
  const sent = [];
  const deps = {
    db, ctx: {}, health: null,
    notify: async (_s, h) => { sent.push(h); },
    getSoldPrices: async () => [650],
    getCex: async () => ({ name: 'iPhone 15 Pro 128GB', sell: 700, cash: 480, voucher: 560, url: 'https://uk.webuy.com/product-detail?id=1' }),
    sources: { v: { search: async () => feed, sellerInfo: async () => { sellerCalls++; return { ratings: sellerRatings }; } } },
  };
  return { db, s, deps, sent, setFeed: (f) => { feed = f; }, sellerCalls: () => sellerCalls };
}

test('likely scams are hidden by default: recorded as flagged, no alert', async () => {
  const t = setup();
  await runSourceOnce(t.s, 'v', t.deps);
  t.setFeed([L('seed', 600), L('scam', 150)]);
  const r = await runSourceOnce(t.s, 'v', t.deps);
  assert.equal(t.sent.length, 0);
  assert.equal(r.newHits.length, 1);
  const hit = t.db.recentHits()[0];
  assert.equal(hit.status, 'flagged');
  assert.equal(hit.listing.scam.risk, 'high');
  assert.equal(hit.listing.seller.ratings, 0);
});

test('flag mode still alerts, marked as a likely scam', async () => {
  const t = setup({ filter: 'flag' });
  await runSourceOnce(t.s, 'v', t.deps);
  t.setFeed([L('seed', 600), L('scam', 150)]);
  await runSourceOnce(t.s, 'v', t.deps);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].listing.scam.risk, 'high');
});

test('a fair deal from a rated seller alerts normally, with CeX prices, and skips the seller lookup', async () => {
  const t = setup({ sellerRatings: 50 });
  await runSourceOnce(t.s, 'v', t.deps);
  t.setFeed([L('seed', 600), L('ok', 420)]);
  await runSourceOnce(t.s, 'v', t.deps);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].estimate.cex.cashProfit, 60);
  assert.equal(t.sent[0].listing.scam.risk, 'low');
  assert.equal(t.sellerCalls(), 0); // not suspiciously cheap, so no extra request
});

test('minProfit counts selling to CeX for cash', async () => {
  const t = setup({ sellerRatings: 50 });
  t.db.updateSearch(t.s.id, { minProfit: 50 });
  t.deps.getSoldPrices = async () => [];
  const s = t.db.getSearch(t.s.id);
  await runSourceOnce(s, 'v', t.deps);
  t.setFeed([L('seed', 600), L('cexflip', 420)]);
  await runSourceOnce(s, 'v', t.deps);
  assert.equal(t.sent.length, 1);
});

test('sellers are looked up for high-value items priced around £80, not only very cheap ones', async () => {
  const t = setup();
  t.deps.getSoldPrices = async () => [150];
  t.deps.getCex = async () => null;
  const s = t.db.updateSearch(t.s.id, { keywords: 'airpods max' });
  t.setFeed([L('seed', 140, 'airpods max')]);
  await runSourceOnce(s, 'v', t.deps);
  t.setFeed([L('seed', 140, 'airpods max'), L('bait', 80, 'airpods max')]);
  await runSourceOnce(s, 'v', t.deps);
  assert.equal(t.sellerCalls(), 1);
  assert.equal(t.sent.length, 0); // hidden as a likely scam
  assert.equal(t.db.recentHits(5, { status: 'flagged' })[0].listing.id, 'bait');
});
