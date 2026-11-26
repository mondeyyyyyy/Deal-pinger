import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';

const L = (id, price = 10) => ({ source: 'ebay', id, title: 't' + id, price, url: 'u' + id, image: null, location: null, postedAt: null });

test('search round-trip', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'PS5', keywords: 'ps5', minPrice: 50, maxPrice: 300, zip: '94110', radius: 30, sources: ['ebay', 'vinted'] });
  assert.equal(s.enabled, true);
  assert.deepEqual(s.sources, ['ebay', 'vinted']);
  assert.equal(s.shipEstimate, 4);
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
  assert.deepEqual(db.getSettings(), { quietStart: null, quietEnd: null, feePct: 0, discordWebhook: null, telegramBotToken: null, telegramChatId: null });
  db.setSettings({ quietStart: '23:00', quietEnd: '07:00' });
  assert.equal(db.getSettings().quietStart, '23:00');
});

test('priceDrops reports listings that got cheaper and stores the new price', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['ebay'] });
  db.markSeen(s.id, [L('1', 100), L('2', 100), L('3', null)]);
  const drops = db.priceDrops(s.id, [L('1', 80), L('2', 97), L('3', 50), L('4', 10)], 0.05);
  assert.deepEqual(drops.map(d => [d.listing.id, d.previousPrice]), [['1', 100]]);
  assert.equal(db.priceDrops(s.id, [L('1', 80)], 0.05).length, 0);
  assert.equal(db.priceDrops(s.id, [L('1', 60)], 0.05)[0].previousPrice, 80);
});

test('prune removes old seen rows and old unsaved hits', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['ebay'] });
  db.markSeen(s.id, [L('old'), L('new')]);
  const h1 = db.addHit(s.id, L('old'));
  const h2 = db.addHit(s.id, L('kept'));
  db.setHitStatus(h2.id, 'saved');
  db.raw.prepare("UPDATE seen SET seenAt = datetime('now', '-50 days') WHERE listingId = 'old'").run();
  db.raw.prepare("UPDATE hits SET createdAt = datetime('now', '-70 days')").run();
  db.prune({ seenDays: 45, hitDays: 60 });
  assert.equal(db.markSeen(s.id, [L('old'), L('new')]).length, 1);
  assert.deepEqual(db.recentHits().map(h => h.id), [h2.id]);
  assert.ok(h1.id);
});

test('settings include selling fee', () => {
  const db = openDb(':memory:');
  assert.equal(db.getSettings().feePct, 0);
  db.setSettings({ feePct: 12.8 });
  assert.equal(db.getSettings().feePct, 12.8);
});

test('resaleOverride is stored on a search', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['ebay'], resaleOverride: 150 });
  assert.equal(s.resaleOverride, 150);
  assert.equal(s.shipEstimate, 4);
});

test('prune keeps the push keys in the cache', () => {
  const db = openDb(':memory:');
  db.cacheSet('vapid', { publicKey: 'p' });
  db.cacheSet('sold:switch', [1]);
  db.raw.prepare('UPDATE cache SET at = 0').run();
  db.prune();
  assert.deepEqual(db.cacheGet('vapid', Infinity), { publicKey: 'p' });
  assert.equal(db.cacheGet('sold:switch', Infinity), undefined);
});

test('searches have a check interval (default 60s)', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['ebay'] });
  assert.equal(s.intervalSec, 60);
  assert.equal(db.updateSearch(s.id, { intervalSec: 30 }).intervalSec, 30);
});

test('flips: buy, sell, summary', () => {
  const db = openDb(':memory:');
  const a = db.addFlip({ title: 'Switch', boughtPrice: 100, source: 'vinted', url: 'https://x' });
  db.addFlip({ title: 'PS5', boughtPrice: 250 });
  assert.equal(a.soldPrice, null);
  const sold = db.updateFlip(a.id, { soldPrice: 160, fees: 6 });
  assert.equal(sold.soldPrice, 160);
  assert.ok(sold.soldAt);
  assert.equal(db.listFlips().length, 2);
  const sum = db.flipSummary();
  assert.equal(sum.stockCount, 1);
  assert.equal(sum.stockValue, 250);
  assert.equal(sum.soldCount, 1);
  assert.equal(sum.totalProfit, 54);
  assert.equal(sum.monthProfit, 54);
  assert.equal(sum.roiPct, 54);
  db.deleteFlip(a.id);
  assert.equal(db.listFlips().length, 1);
});

test('alert channel settings', () => {
  const db = openDb(':memory:');
  db.setSettings({ discordWebhook: 'https://discord.com/api/webhooks/1/abc', telegramBotToken: '123:ABC', telegramChatId: '42' });
  const s = db.getSettings();
  assert.equal(s.discordWebhook, 'https://discord.com/api/webhooks/1/abc');
  assert.equal(s.telegramBotToken, '123:ABC');
  assert.equal(s.telegramChatId, '42');
  db.setSettings({ discordWebhook: '' });
  assert.equal(db.getSettings().discordWebhook, null);
});
