import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createHealth, runSourceOnce } from '../src/poller.js';
import { matches, keywordVariants } from '../src/match.js';
import { formatPush } from '../src/notify.js';

// ---------- keyword variants ----------
test('"a | b" keywords match either variant', () => {
  assert.deepEqual(keywordVariants('ps5 | playstation 5 |  '), ['ps5', 'playstation 5']);
  const s = { keywords: 'ps5 | playstation 5', excludeWords: '' };
  assert.equal(matches({ title: 'Sony PlayStation 5 disc' }, s), true);
  assert.equal(matches({ title: 'PS5 slim' }, s), true);
  assert.equal(matches({ title: 'Xbox series x' }, s), false);
});

test('each variant is searched and results are merged without duplicates', async () => {
  const db = openDb(':memory:');
  db.setSettings({ scamFilter: 'off' });
  const s = db.addSearch({ name: 'PS5', keywords: 'ps5 | playstation 5', sources: ['a'] });
  const queries = [];
  const L = (id, title) => ({ source: 'a', id, title, price: 100, url: 'https://x/' + id, image: null, location: null, postedAt: null });
  const deps = { db, ctx: {}, getSoldPrices: async () => [], notify: async () => {}, sources: { a: { search: async (q) => {
    queries.push(q.keywords);
    return q.keywords === 'ps5' ? [L('1', 'ps5 slim'), L('2', 'playstation 5 ps5')] : [L('2', 'playstation 5 ps5'), L('3', 'playstation 5 disc')];
  } } } };
  await runSourceOnce(s, 'a', deps);
  assert.deepEqual(queries, ['ps5', 'playstation 5']);
  assert.equal(db.markSeen(s.id, [L('1'), L('2'), L('3')]).length, 0); // all three were recorded once
});

// ---------- tap-to-checkout ----------
test('alerts can open checkout directly when chosen (never for risky listings)', () => {
  const l = { source: 'vinted', id: '1', title: 't', price: 5, url: 'https://v/1', buyUrl: 'https://v/buy/1', scam: { risk: 'low', reasons: [] } };
  assert.equal(formatPush({ name: 's' }, { id: 1, listing: l, estimate: null }, undefined, { tapOpens: 'buy' }).url, 'https://v/buy/1');
  assert.equal(formatPush({ name: 's' }, { id: 1, listing: l, estimate: null }).url, 'https://v/1');
  assert.equal(formatPush({ name: 's' }, { id: 1, listing: { ...l, scam: { risk: 'medium', reasons: ['x'] } }, estimate: null }, undefined, { tapOpens: 'buy' }).url, 'https://v/1');
});

// ---------- server ----------
let server, base, db, cookie;
before(async () => {
  db = openDb(':memory:');
  const notify = async () => 1; notify.sendRaw = async () => 1;
  const app = createApp({ db, config: { appPassword: 'pw', sessionSecret: 's' }, runNow: async () => ({ newHits: [], errors: [] }), notify, health: createHealth(), cex: { search: async () => [] } });
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = await login();
});
after(() => server.close());
async function login() {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  return r.headers.get('set-cookie').split(';')[0];
}
const req = (path, { method = 'GET', body, c = cookie } = {}) => fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: c }, body: body ? JSON.stringify(body) : undefined });

test('searches list deal counts and the last deal time', async () => {
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['vinted'] });
  db.addHit(s.id, { source: 'vinted', id: '1', title: 'x', price: 1, url: 'https://x', image: null, location: null, postedAt: null });
  db.addHit(s.id, { source: 'vinted', id: '2', title: 'x', price: 1, url: 'https://x', image: null, location: null, postedAt: null }, null, 'flagged');
  const row = (await (await req('/api/searches')).json()).find(r => r.id === s.id);
  assert.equal(row.hitCount, 1);
  assert.ok(row.lastHitAt);
});

test('tap setting is validated', async () => {
  assert.equal((await req('/api/settings', { method: 'PUT', body: { tapOpens: 'nowhere' } })).status, 400);
  assert.equal((await (await req('/api/settings', { method: 'PUT', body: { tapOpens: 'buy' } })).json()).tapOpens, 'buy');
});

test('backup has no secrets, and restore adds searches and flips', async () => {
  db.setSettings({ telegramBotToken: '1:SECRET', discordWebhook: 'https://discord.com/api/webhooks/1/SECRET', feePct: 12 });
  db.addSearch({ name: 'hooked', keywords: 'h', sources: ['vinted'], discordWebhook: 'https://discord.com/api/webhooks/2/SECRET' });
  db.addFlip({ title: 'PS5', boughtPrice: 200 });
  const backup = await (await req('/api/backup')).json();
  assert.doesNotMatch(JSON.stringify(backup), /SECRET/);
  assert.equal(backup.settings.feePct, 12);
  const n = db.listSearches().length;
  const r = await (await req('/api/restore', { method: 'POST', body: backup })).json();
  assert.equal(r.searches, 0); // same searches already exist: skipped, not doubled
  assert.equal(r.skipped, n);
  assert.equal(db.listSearches().length, n);
  assert.equal(db.listFlips().length, 2);
  assert.equal((await req('/api/restore', { method: 'POST', body: { searches: 'nope' } })).status, 400);
  const big = { searches: [], flips: Array.from({ length: 2000 }, (_, i) => ({ title: 'Flip number ' + i + ' with a fairly long description', boughtPrice: 10 })) };
  assert.equal((await req('/api/restore', { method: 'POST', body: big })).status, 200); // > 64kb
});

test('log out all devices invalidates every existing session', async () => {
  const other = await login();
  assert.equal((await req('/api/searches', { c: other })).status, 200);
  assert.equal((await req('/api/logout-all', { method: 'POST', c: other })).status, 200);
  assert.equal((await req('/api/searches', { c: other })).status, 401);
  assert.equal((await req('/api/searches')).status, 401);
  cookie = await login();
  assert.equal((await req('/api/searches')).status, 200);
});
