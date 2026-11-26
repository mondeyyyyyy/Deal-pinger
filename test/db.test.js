import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';

const L = (id, price = 10) => ({ source: 'ebay', id, title: 't' + id, price, url: 'u' + id, image: null, location: null, postedAt: null });

test('search round-trip', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'PS5', keywords: 'ps5', minPrice: 50, maxPrice: 300, zip: '94110', radius: 30, sources: ['ebay', 'craigslist'] });
  assert.equal(s.enabled, true);
  assert.deepEqual(s.sources, ['ebay', 'craigslist']);
  assert.equal(s.shipEstimate, 12);
  assert.equal(db.listSearches().length, 1);
  const u = db.updateSearch(s.id, { enabled: false, maxPrice: 250, excludeWords: 'broken' });
  assert.equal(u.enabled, false);
  assert.equal(u.maxPrice, 250);
  assert.equal(u.excludeWords, 'broken');
  db.deleteSearch(s.id);
  assert.equal(db.listSearches().length, 0);
});

test('markSeen returns only unseen listings', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['ebay'] });
  assert.equal(db.hasSeenAny(s.id), false);
  assert.equal(db.markSeen(s.id, [L('1'), L('2')]).length, 2);
  assert.equal(db.hasSeenAny(s.id), true);
  assert.equal(db.markSeen(s.id, [L('1'), L('2')]).length, 0);
  assert.deepEqual(db.markSeen(s.id, [L('1'), L('3')]).map(l => l.id), ['3']);
});

test('hits are recorded and status can change', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['ebay'] });
  const h = db.addHit(s.id, L('9', 40), { value: 100, profit: 30, score: 60 });
  const hits = db.recentHits();
  assert.equal(hits.length, 1);
  assert.equal(hits[0].listing.id, '9');
  assert.equal(hits[0].estimate.profit, 30);
  assert.equal(hits[0].status, 'new');
  db.setHitStatus(h.id, 'saved');
  assert.equal(db.recentHits()[0].status, 'saved');
});

test('subscriptions dedupe on endpoint', () => {
  const db = openDb(':memory:');
  db.addSubscription({ endpoint: 'e1', keys: { p256dh: 'a', auth: 'b' } });
  db.addSubscription({ endpoint: 'e1', keys: { p256dh: 'a', auth: 'b' } });
  assert.equal(db.listSubscriptions().length, 1);
  db.removeSubscription('e1');
  assert.equal(db.listSubscriptions().length, 0);
});

test('price history and settings', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['ebay'] });
  db.markSeen(s.id, [L('1', 100), L('2', null)]);
  const hist = db.priceHistory(s.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].price, 100);
  assert.deepEqual(db.getSettings(), { quietStart: null, quietEnd: null });
  db.setSettings({ quietStart: '23:00', quietEnd: '07:00' });
  assert.equal(db.getSettings().quietStart, '23:00');
});
