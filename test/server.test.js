import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createHealth } from '../src/poller.js';

let server, base, db, pushes = [];

before(async () => {
  db = openDb(':memory:');
  const notify = async () => 1;
  notify.sendRaw = async (p) => { pushes.push(p); return 1; };
  const app = createApp({
    db,
    config: { appPassword: 'hunter2', sessionSecret: 's', vapidPublicKey: 'PUB' },
    runNow: async () => ({ newHits: [], errors: [] }),
    notify,
    health: createHealth(),
  });
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const req = (path, { cookie, method = 'GET', body } = {}) => fetch(base + path, {
  method,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

async function login() {
  const r = await req('/api/login', { method: 'POST', body: { password: 'hunter2' } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

test('api requires auth', async () => {
  for (const p of ['/api/searches', '/api/hits', '/api/settings', '/api/status']) {
    assert.equal((await req(p)).status, 401, p);
  }
  assert.equal((await req('/healthz')).status, 200);
});

test('wrong password is rejected', async () => {
  assert.equal((await req('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  assert.equal((await req('/api/login', { method: 'POST', body: {} })).status, 401);
});

test('forged cookie is rejected', async () => {
  assert.equal((await req('/api/searches', { cookie: 'dp_session=ok' })).status, 401);
});

test('create, list, update, delete a search', async () => {
  const cookie = await login();
  const bad = await req('/api/searches', { cookie, method: 'POST', body: { name: 'x', keywords: '', sources: ['ebay'] } });
  assert.equal(bad.status, 400);
  const badSrc = await req('/api/searches', { cookie, method: 'POST', body: { name: 'x', keywords: 'ps5', sources: ['myspace'] } });
  assert.equal(badSrc.status, 400);
  const r = await req('/api/searches', { cookie, method: 'POST', body: { name: 'PS5', keywords: 'ps5', maxPrice: '300', sources: ['ebay', 'vinted'] } });
  assert.equal(r.status, 201);
  const s = await r.json();
  assert.equal(s.maxPrice, 300);
  const list = await (await req('/api/searches', { cookie })).json();
  assert.equal(list.length, 1);
  const u = await (await req(`/api/searches/${s.id}`, { cookie, method: 'PUT', body: { enabled: false } })).json();
  assert.equal(u.enabled, false);
  assert.equal((await req(`/api/searches/${s.id}/history`, { cookie })).status, 200);
  assert.equal((await req(`/api/searches/${s.id}`, { cookie, method: 'DELETE' })).status, 204);
});

test('hits can be saved and dismissed', async () => {
  const cookie = await login();
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['ebay'] });
  const h = db.addHit(s.id, { source: 'ebay', id: '1', title: 'x', price: 1, url: 'https://x', image: null, location: null, postedAt: null });
  assert.equal((await req(`/api/hits/${h.id}`, { cookie, method: 'PUT', body: { status: 'bogus' } })).status, 400);
  assert.equal((await req(`/api/hits/${h.id}`, { cookie, method: 'PUT', body: { status: 'dismissed' } })).status, 200);
  const hits = await (await req('/api/hits', { cookie })).json();
  assert.equal(hits.find(x => x.id === h.id), undefined);
});

test('settings, vapid, subscribe, test push', async () => {
  const cookie = await login();
  const st = await (await req('/api/settings', { cookie, method: 'PUT', body: { quietStart: '23:00', quietEnd: '07:00' } })).json();
  assert.equal(st.quietStart, '23:00');
  assert.equal((await req('/api/settings', { cookie, method: 'PUT', body: { quietStart: '9pm' } })).status, 400);
  assert.equal((await (await req('/api/vapid', { cookie })).json()).publicKey, 'PUB');
  assert.equal((await req('/api/subscribe', { cookie, method: 'POST', body: { endpoint: 'https://push/x', keys: { p256dh: 'a', auth: 'b' } } })).status, 201);
  assert.equal(db.listSubscriptions().length, 1);
  const tp = await (await req('/api/test-push', { cookie, method: 'POST' })).json();
  assert.equal(tp.sent, 1);
  assert.equal(pushes.length, 1);
});

test('selling fee and resale override validation', async () => {
  const cookie = await login();
  assert.equal((await (await req('/api/settings', { cookie, method: 'PUT', body: { feePct: '12.8' } })).json()).feePct, 12.8);
  assert.equal((await req('/api/settings', { cookie, method: 'PUT', body: { feePct: 'abc' } })).status, 400);
  assert.equal((await req('/api/settings', { cookie, method: 'PUT', body: { feePct: 80 } })).status, 400);
  const s = await (await req('/api/searches', { cookie, method: 'POST', body: { keywords: 'ps5', resaleOverride: '320', zip: 'M1 1AE', sources: ['vinted'] } })).json();
  assert.equal(s.resaleOverride, 320);
  assert.equal(s.zip, 'M1 1AE');
});

// Keep last: it locks this IP out of logging in.
test('login is rate limited after repeated failures', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await req('/api/login', { method: 'POST', body: { password: 'bad' + i } });
  assert.equal(last.status, 429);
});
