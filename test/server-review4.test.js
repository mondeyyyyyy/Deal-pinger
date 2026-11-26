import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createHealth } from '../src/poller.js';
import { ensureSessionSecret } from '../src/config.js';

let server, base, db, cookie;
before(async () => {
  db = openDb(':memory:');
  const notify = async () => 1; notify.sendRaw = async () => 1;
  const app = createApp({ db, config: { appPassword: 'pw', sessionSecret: 's' }, runNow: async () => ({ newHits: [], errors: [] }), notify, health: createHealth(), cex: { search: async () => [] } });
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => server.close());
const req = (path, { method = 'GET', body } = {}) => fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
const L = (id) => ({ source: 'vinted', id, title: 'Item ' + id, price: 10, url: 'https://v/' + id, image: null, location: null, postedAt: null });

test('prices like "£1,250" are accepted, and errors use plain names', async () => {
  const s = await (await req('/api/searches', { method: 'POST', body: { keywords: 'x', sources: ['vinted'], maxPrice: '£1,250' } })).json();
  assert.equal(s.maxPrice, 1250);
  const bad = await (await req('/api/searches', { method: 'POST', body: { keywords: 'x', sources: ['vinted'], maxPrice: 'lots' } })).json();
  assert.equal(bad.error, 'Max price must be a number of pounds');
});

test('restore is all-or-nothing and skips searches you already have', async () => {
  const before = db.listSearches().length;
  const bad = await req('/api/restore', { method: 'POST', body: { searches: [{ keywords: 'new one', sources: ['vinted'] }], flips: [{ title: 'x', boughtPrice: 5, fees: 'lots' }] } });
  assert.equal(bad.status, 400);
  assert.equal(db.listSearches().length, before);
  const ok = await (await req('/api/restore', { method: 'POST', body: { searches: [{ keywords: 'x', sources: ['vinted'] }, { keywords: 'fresh', sources: ['ebay'] }], flips: [{ title: 'y', boughtPrice: '£5', fees: '£1.50' }] } })).json();
  assert.equal(ok.searches, 1); // "x" on Vinted already exists
  assert.equal(ok.skipped, 1);
  assert.equal(db.listFlips().find(f => f.title === 'y').fees, 1.5);
});

test('Bought and Not-a-scam work on older deals too', async () => {
  const s = db.addSearch({ name: 'old', keywords: 'o', sources: ['vinted'] });
  const old = db.addHit(s.id, L('old'), null, 'flagged');
  for (let i = 0; i < 1100; i++) db.addHit(s.id, L('n' + i));
  assert.equal((await req(`/api/hits/${old.id}`, { method: 'PUT', body: { status: 'new' } })).status, 200);
  assert.ok(db.cacheGet('trust:vinted:old', Infinity));
  const f = await (await req('/api/flips', { method: 'POST', body: { hitId: old.id } })).json();
  assert.equal(f.title, 'Item old');
  const saved = await (await req('/api/hits?status=saved')).json();
  assert.ok(saved.some(h => h.id === old.id)); // buying saves it, and saved deals are found however old
});

test('a random session secret is created once and reused when none is configured', () => {
  const d = openDb(':memory:');
  const c1 = { sessionSecret: null };
  ensureSessionSecret(d, c1);
  assert.ok(c1.sessionSecret.length >= 32);
  const c2 = { sessionSecret: null };
  ensureSessionSecret(d, c2);
  assert.equal(c2.sessionSecret, c1.sessionSecret);
  const c3 = { sessionSecret: 'from-env' };
  ensureSessionSecret(d, c3);
  assert.equal(c3.sessionSecret, 'from-env');
});
