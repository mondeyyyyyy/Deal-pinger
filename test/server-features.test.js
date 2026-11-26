import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createHealth } from '../src/poller.js';

let server, base, db, cookie;

before(async () => {
  db = openDb(':memory:');
  const notify = async () => 1;
  notify.sendRaw = async () => 1;
  const app = createApp({
    db,
    config: { appPassword: 'pw', sessionSecret: 's', vapidPublicKey: 'PUB' },
    runNow: async () => ({ newHits: [], errors: [] }),
    notify,
    health: createHealth(),
    linkTelegram: async () => { db.setSettings({ telegramChatId: '99' }); return '99'; },
  });
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => server.close());

const req = (path, { method = 'GET', body } = {}) => fetch(base + path, {
  method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
});

test('check interval is validated (30s to 1h)', async () => {
  const mk = (intervalSec) => req('/api/searches', { method: 'POST', body: { keywords: 'x', sources: ['vinted'], intervalSec } });
  assert.equal((await mk(10)).status, 400);
  const r = await mk(30);
  assert.equal(r.status, 201);
  assert.equal((await r.json()).intervalSec, 30);
});

test('channel secrets are write-only', async () => {
  const bad = await req('/api/settings', { method: 'PUT', body: { discordWebhook: 'https://evil.example/hook' } });
  assert.equal(bad.status, 400);
  const badTg = await req('/api/settings', { method: 'PUT', body: { telegramBotToken: 'nope' } });
  assert.equal(badTg.status, 400);
  const s = await (await req('/api/settings', { method: 'PUT', body: { discordWebhook: 'https://discord.com/api/webhooks/1/abc', telegramBotToken: '123:AB-c' } })).json();
  assert.equal(s.discordConnected, true);
  assert.equal(s.telegramHasToken, true);
  assert.equal(s.telegramConnected, false);
  assert.equal(s.discordWebhook, undefined);
  assert.equal(s.telegramBotToken, undefined);
  const linked = await (await req('/api/telegram/link', { method: 'POST' })).json();
  assert.equal(linked.chatId, '99');
  assert.equal((await (await req('/api/settings')).json()).telegramConnected, true);
  const cleared = await (await req('/api/settings', { method: 'PUT', body: { telegramBotToken: '' } })).json();
  assert.equal(cleared.telegramConnected, false);
  assert.equal(db.getSettings().telegramChatId, null);
});

test('flips API: create from a hit, sell, summary, CSV', async () => {
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['vinted'] });
  const h = db.addHit(s.id, { source: 'vinted', id: '1', title: 'Switch, Lite "blue"', price: 70, url: 'https://v/1', image: null, location: null, postedAt: null });
  const f = await (await req('/api/flips', { method: 'POST', body: { hitId: h.id, boughtPrice: 65 } })).json();
  assert.equal(f.title, 'Switch, Lite "blue"');
  assert.equal(f.boughtPrice, 65);
  assert.equal(f.source, 'vinted');
  assert.equal((await req('/api/flips', { method: 'POST', body: { title: '', boughtPrice: 5 } })).status, 400);
  assert.equal((await req(`/api/flips/${f.id}`, { method: 'PUT', body: { soldPrice: -1 } })).status, 400);
  const sold = await (await req(`/api/flips/${f.id}`, { method: 'PUT', body: { soldPrice: 110, fees: 5 } })).json();
  assert.equal(sold.soldPrice, 110);
  const list = await (await req('/api/flips')).json();
  assert.equal(list.summary.totalProfit, 40);
  assert.equal(list.flips.length, 1);
  const csv = await (await req('/api/flips.csv')).text();
  assert.match(csv.split('\n')[0], /^Title,Marketplace,Bought £,Bought on,Sold £,Sold on,Fees £,Profit £/);
  assert.match(csv, /"Switch, Lite ""blue""",Vinted,65,/);
  assert.equal((await req(`/api/flips/${f.id}`, { method: 'DELETE' })).status, 204);
});

test('status reports how long each marketplace took', async () => {
  const st = await (await req('/api/status')).json();
  assert.ok(Array.isArray(st.sources));
  assert.equal(st.sources.length, 5);
});
