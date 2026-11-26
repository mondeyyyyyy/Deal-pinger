import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { startPoller, runSourceOnce, createHealth } from '../src/poller.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function deps(sources) {
  const db = openDb(':memory:');
  return { db, sources, notify: async () => {}, ctx: {}, getSoldPrices: async () => [], health: createHealth() };
}

function tracker(lane, ms = 40) {
  const t = { lane, calls: 0, active: 0, max: 0 };
  t.search = async () => { t.calls++; t.active++; t.max = Math.max(t.max, t.active); await sleep(ms); t.active--; return []; };
  return t;
}

test('browser lane runs one page at a time when its limit is 1', async () => {
  const br = tracker('browser');
  const d = deps({ br });
  d.db.addSearch({ name: '1', keywords: 'a', sources: ['br'] });
  d.db.addSearch({ name: '2', keywords: 'b', sources: ['br'] });
  const p = startPoller(d, { tickMs: 3600000, lanes: { fetch: 4, browser: 1 }, log: {} });
  await sleep(150);
  await p.stop();
  assert.equal(br.calls, 2);
  assert.equal(br.max, 1);
});

test('fetch lane runs different searches in parallel', async () => {
  const f = tracker('fetch');
  const d = deps({ f });
  d.db.addSearch({ name: '1', keywords: 'a', sources: ['f'] });
  d.db.addSearch({ name: '2', keywords: 'b', sources: ['f'] });
  const p = startPoller(d, { tickMs: 3600000, lanes: { fetch: 4, browser: 1 }, log: {} });
  await sleep(100);
  await p.stop();
  assert.equal(f.max, 2);
});

test('each search is checked on its own interval', async () => {
  const f = tracker('fetch', 1);
  const d = deps({ f });
  d.db.addSearch({ name: 'fast', keywords: 'a', sources: ['f'], intervalSec: 30 });
  let now = 0;
  const p = startPoller(d, { tickMs: 3600000, now: () => now, jitter: 0, log: {} });
  await sleep(10);
  assert.equal(f.calls, 1);
  now = 20000; p.tick(); await sleep(10);
  assert.equal(f.calls, 1);
  now = 31000; p.tick(); await sleep(10);
  assert.equal(f.calls, 2);
  await p.stop();
});

test('a source minimum interval beats a faster search interval', async () => {
  const f = tracker('fetch', 1);
  f.minIntervalSec = () => 45;
  const d = deps({ f });
  d.db.addSearch({ name: 'fast', keywords: 'a', sources: ['f'], intervalSec: 30 });
  let now = 0;
  const p = startPoller(d, { tickMs: 3600000, now: () => now, jitter: 0, log: {} });
  await sleep(10);
  now = 31000; p.tick(); await sleep(10);
  assert.equal(f.calls, 1);
  now = 46000; p.tick(); await sleep(10);
  assert.equal(f.calls, 2);
  await p.stop();
});

test('paused searches are not checked', async () => {
  const f = tracker('fetch', 1);
  const d = deps({ f });
  d.db.addSearch({ name: 'off', keywords: 'a', sources: ['f'], enabled: false });
  const p = startPoller(d, { tickMs: 3600000, log: {} });
  await sleep(20);
  await p.stop();
  assert.equal(f.calls, 0);
});

test('runNow checks every source of a search and reports per-source errors', async () => {
  const ok = { lane: 'fetch', search: async () => [] };
  const bad = { lane: 'browser', search: async () => { throw new Error('blocked'); } };
  const d = deps({ ok, bad });
  const s = d.db.addSearch({ name: 's', keywords: 'a', sources: ['ok', 'bad'], enabled: false });
  const p = startPoller(d, { tickMs: 3600000, log: {} });
  const r = await p.runNow(s.id);
  await p.stop();
  assert.equal(r.newHits.length, 0);
  assert.deepEqual(r.errors, [{ source: 'bad', message: 'blocked' }]);
  assert.equal(d.health.get().bad.ok, false);
  assert.equal(typeof d.health.get().ok.ms, 'number');
});

test('slow sold-price lookups do not hold back the alert', async () => {
  const d = deps({ a: { search: async () => listings } });
  let listings = [{ source: 'a', id: '1', title: 'switch', price: 10, url: 'https://x/1', image: null, location: null, postedAt: null }];
  const sent = [];
  d.notify = async (_s, h) => { sent.push(h); };
  d.getSoldPrices = () => new Promise(r => setTimeout(() => r([100]), 10000));
  d.compsWaitMs = 50;
  d.db.setSettings({ scamFilter: 'off' }); // pure speed path: with 'hide', a cold price cache is waited for (safety)
  const s = d.db.addSearch({ name: 's', keywords: 'switch', sources: ['a'] });
  await runSourceOnce(s, 'a', d);
  listings = [...listings, { ...listings[0], id: '2' }];
  const t0 = Date.now();
  await runSourceOnce(s, 'a', d);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].estimate, null);
});

test('bursts go through notify.batch when available', async () => {
  const d = deps({ a: { search: async () => listings } });
  let listings = [{ source: 'a', id: 'seed', title: 'x', price: 1, url: 'https://x', image: null, location: null, postedAt: null }];
  const batches = [];
  d.notify = async () => {};
  d.notify.batch = async (_s, hits) => { batches.push(hits.length); };
  const s = d.db.addSearch({ name: 's', keywords: 'x', sources: ['a'] });
  await runSourceOnce(s, 'a', d);
  listings = [...listings, ...Array.from({ length: 5 }, (_, i) => ({ source: 'a', id: String(i), title: 'x', price: 1, url: 'https://x', image: null, location: null, postedAt: null }))];
  await runSourceOnce(s, 'a', d);
  assert.deepEqual(batches, [5]);
});

test('prices are pre-loaded for each enabled search, then refreshed every few hours', async () => {
  const d = deps({ f: { search: async () => [] } });
  const warmed = [];
  d.warm = async (s) => { warmed.push(s.name); };
  d.db.addSearch({ name: 'on', keywords: 'a', sources: ['f'] });
  d.db.addSearch({ name: 'off', keywords: 'b', sources: ['f'], enabled: false });
  let now = 0;
  const p = startPoller(d, { tickMs: 3600000, now: () => now, jitter: 0, log: {} });
  await sleep(5);
  assert.deepEqual(warmed, ['on']);
  now = 3600000; p.tick(); await sleep(5);
  assert.deepEqual(warmed, ['on']);
  now = 6 * 3600000 + 1; p.tick(); await sleep(5);
  assert.deepEqual(warmed, ['on', 'on']);
  await p.stop();
});

test('a marketplace failing for 30+ minutes sends one warning, and one when it recovers', async () => {
  let fail = true;
  const fb = { label: 'Facebook Marketplace', search: async () => { if (fail) throw new Error('blocked 403'); return []; } };
  const d = deps({ fb });
  const raw = [];
  d.notify.sendRaw = async (p) => { raw.push(p); return 1; };
  d.db.addSearch({ name: 's', keywords: 'a', sources: ['fb'], intervalSec: 60 });
  let now = 0;
  const p = startPoller(d, { tickMs: 3600000, now: () => now, jitter: 0, log: {} });
  for (const t of [10, 20, 31, 45]) { now = t * 60000; p.tick(); await sleep(5); }
  assert.equal(raw.length, 1);
  assert.match(raw[0].title, /Facebook Marketplace/);
  assert.match(raw[0].body, /PROXY_URL|proxy/i);
  fail = false;
  now = 50 * 60000; p.tick(); await sleep(5);
  assert.equal(raw.length, 2);
  assert.match(raw[1].title, /working again/i);
  await p.stop();
});
