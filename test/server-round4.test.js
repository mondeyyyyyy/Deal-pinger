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
  const cex = { search: async (q) => [{ id: '1', name: `CeX ${q}`, sell: 10, cash: 5, voucher: 7, url: 'https://uk.webuy.com/product-detail?id=1' }] };
  const app = createApp({ db, config: { appPassword: 'pw', sessionSecret: 's' }, runNow: async () => ({ newHits: [], errors: [] }), notify, health: createHealth(), cex });
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => server.close());
const req = (path, { method = 'GET', body } = {}) => fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });

test('scam filter and Discord mention settings', async () => {
  assert.equal((await (await req('/api/settings')).json()).scamFilter, 'hide');
  assert.equal((await req('/api/settings', { method: 'PUT', body: { scamFilter: 'nope' } })).status, 400);
  assert.equal((await req('/api/settings', { method: 'PUT', body: { discordMention: '@someone' } })).status, 400);
  const s = await (await req('/api/settings', { method: 'PUT', body: { scamFilter: 'flag', discordMention: '@here' } })).json();
  assert.equal(s.scamFilter, 'flag');
  assert.equal(s.discordMention, '@here');
  assert.equal((await (await req('/api/settings', { method: 'PUT', body: { discordMention: '123456789012345678' } })).json()).discordMention, '123456789012345678');
});

test('per-search Discord channel is write-only and validated', async () => {
  assert.equal((await req('/api/searches', { method: 'POST', body: { keywords: 'x', sources: ['vinted'], discordWebhook: 'https://evil.example/x' } })).status, 400);
  const s = await (await req('/api/searches', { method: 'POST', body: { keywords: 'x', sources: ['vinted'], discordWebhook: 'https://discord.com/api/webhooks/9/abc' } })).json();
  assert.equal(s.discordWebhook, undefined);
  assert.equal(s.hasDiscordWebhook, true);
  const list = await (await req('/api/searches')).json();
  assert.equal(list[0].discordWebhook, undefined);
  assert.equal(db.getSearch(s.id).discordWebhook, 'https://discord.com/api/webhooks/9/abc');
  const cleared = await (await req(`/api/searches/${s.id}`, { method: 'PUT', body: { discordWebhook: '' } })).json();
  assert.equal(cleared.hasDiscordWebhook, false);
});

test('CeX search for pinning an item, and CeX fields on a search', async () => {
  const r = await (await req('/api/cex/search?q=ps5')).json();
  assert.equal(r[0].name, 'CeX ps5');
  const s = await (await req('/api/searches', { method: 'POST', body: { keywords: 'ps5', sources: ['ebay'], cexBoxId: '711719521290', cexName: 'PS5 Disc', cexMode: 'auto' } })).json();
  assert.equal(s.cexBoxId, '711719521290');
  assert.equal((await req('/api/searches', { method: 'POST', body: { keywords: 'ps5', sources: ['ebay'], cexMode: 'sometimes' } })).status, 400);
});

test('15-second checks allowed; flagged hits can be reviewed', async () => {
  assert.equal((await req('/api/searches', { method: 'POST', body: { keywords: 'x', sources: ['vinted'], intervalSec: 15 } })).status, 201);
  assert.equal((await req('/api/searches', { method: 'POST', body: { keywords: 'x', sources: ['vinted'], intervalSec: 10 } })).status, 400);
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['vinted'] });
  const h = db.addHit(s.id, { source: 'vinted', id: '1', title: 'x', price: 1, url: 'https://x', image: null, location: null, postedAt: null }, null, 'flagged');
  const flagged = await (await req('/api/hits?status=flagged')).json();
  assert.equal(flagged[0].id, h.id);
  assert.equal((await req(`/api/hits/${h.id}`, { method: 'PUT', body: { status: 'new' } })).status, 200);
});

test('evening summary time is validated and can be switched off', async () => {
  assert.equal((await req('/api/settings', { method: 'PUT', body: { digestTime: '8pm' } })).status, 400);
  assert.equal((await (await req('/api/settings', { method: 'PUT', body: { digestTime: '20:30' } })).json()).digestTime, '20:30');
  assert.equal((await (await req('/api/settings', { method: 'PUT', body: { digestTime: '' } })).json()).digestTime, null);
});
