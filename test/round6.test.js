import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSourceOnce } from '../src/poller.js';
import { matches } from '../src/match.js';
import * as vinted from '../src/sources/vinted.js';

const L = (id, price, title = 'ps5 console', extra = {}) => ({ source: 'v', id, title, price, url: 'https://x/' + id, image: null, location: null, postedAt: null, ...extra });

test('"wanted" posts and swap-only listings are never deals', () => {
  const s = { keywords: 'ps5', excludeWords: '' };
  for (const t of ['WANTED PS5', 'Wanted: ps5 disc', 'WTB ps5', 'Looking for a PS5', 'ISO ps5', 'PS5 swap only', 'ps5 - trade only, no sale'])
    assert.equal(matches({ title: t }, s), false, t);
  for (const t of ['PS5 console', 'PS5 - not wanted gift', 'PS5, open to swaps or cash'])
    assert.equal(matches({ title: t }, s), true, t);
});

function setup(n = 2) {
  const db = openDb(':memory:');
  db.setSettings({ scamFilter: 'off' });
  const searches = Array.from({ length: n }, (_, i) => db.addSearch({ name: 's' + i, keywords: 'ps5', sources: ['v'] }));
  const t = { db, searches, feed: [L('seed', 200)], sent: [] };
  t.deps = { db, ctx: {}, compsWaitMs: 20, getSoldPrices: async () => [], notify: async (s, h) => t.sent.push([s.name, h.listing.id]), sources: { v: { search: async () => t.feed } } };
  return t;
}

test('the same listing caught by two searches pings once', async () => {
  const t = setup(2);
  for (const s of t.searches) await runSourceOnce(s, 'v', t.deps);
  t.feed = [...t.feed, L('dupe', 200)];
  for (const s of t.searches) await runSourceOnce(s, 'v', t.deps);
  assert.deepEqual(t.sent, [['s0', 'dupe']]);
  assert.equal(t.db.recentHits().filter(h => h.listing.id === 'dupe').length, 2); // still on both searches' lists
});

test('details (Vinted description) are fetched for new deals and feed the scam check', async () => {
  const t = setup(1);
  t.db.setSettings({ scamFilter: 'flag' });
  let calls = 0;
  t.deps.sources.v.details = async (l) => { calls++; return { description: 'Brand new. Bank transfer only please' }; };
  await runSourceOnce(t.searches[0], 'v', t.deps);
  assert.equal(calls, 0); // not on the silent first run
  t.feed = [...t.feed, L('new', 200)];
  await runSourceOnce(t.searches[0], 'v', t.deps);
  assert.equal(calls, 1);
  const hit = t.db.recentHits()[0];
  assert.match(hit.listing.description, /bank transfer/i);
  assert.ok(hit.listing.scam.reasons.some(r => /bank transfer/.test(r)));
});

test('vinted details parse the description and seller ratings from the item API', async () => {
  vinted._resetForTests();
  const ctx = { fetch: async (url) => {
    if (url.endsWith('/')) return { ok: true, status: 200, headers: { getSetCookie: () => ['a=b'] } };
    assert.match(url, /\/api\/v2\/items\/42$/);
    return { ok: true, status: 200, json: async () => ({ item: { description: 'Collection only, Leeds', user: { login: 'amy', feedback_count: 12 } } }) };
  } };
  const d = await vinted.details({ id: '42' }, ctx);
  assert.equal(d.description, 'Collection only, Leeds');
  assert.deepEqual(d.seller, { name: 'amy', ratings: 12 });
});
