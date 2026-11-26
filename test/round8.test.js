import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createHealth, runSourceOnce } from '../src/poller.js';
import { relistText, profitFor } from '../public/tools.js';

const L = (id, price, extra = {}) => ({ source: 'vinted', id, title: 'ps5 console', price, url: 'https://v/' + id, image: null, location: null, postedAt: null, ...extra });

test('blocked sellers never show up again', async () => {
  const db = openDb(':memory:');
  db.setSettings({ scamFilter: 'off' });
  const s = db.addSearch({ name: 's', keywords: 'ps5', sources: ['vinted'] });
  let feed = [L('seed', 200)];
  const sent = [];
  const deps = { db, ctx: {}, compsWaitMs: 20, getSoldPrices: async () => [], notify: async (_s, h) => sent.push(h.listing.id), sources: { vinted: { search: async () => feed } } };
  await runSourceOnce(s, 'vinted', deps);
  db.blockSeller({ source: 'vinted', sellerId: '77', name: 'spammy_shop' });
  feed = [...feed, L('a', 150, { sellerId: '77', sellerName: 'spammy_shop' }), L('b', 150, { sellerId: '88' })];
  await runSourceOnce(s, 'vinted', deps);
  assert.deepEqual(sent, ['b']);
  // eBay sellers are matched by username
  db.blockSeller({ source: 'ebay', name: 'flipper99' });
  assert.equal(db.isBlocked({ source: 'ebay', seller: { name: 'FLIPPER99' } }), true);
  assert.equal(db.isBlocked({ source: 'ebay', seller: { name: 'someone' } }), false);
});

test('profit calculator', () => {
  assert.deepEqual(profitFor({ buy: 100, sell: 160, feePct: 0, postage: 4 }), { profit: 56, roiPct: 56 });
  assert.deepEqual(profitFor({ buy: 100, sell: 160, feePct: 12.8, postage: 4 }), { profit: 35.52, roiPct: 36 });
  assert.equal(profitFor({ buy: 0, sell: 10, feePct: 0, postage: 0 }).roiPct, null);
});

test('relist text', () => {
  const t = relistText({ title: 'PS5 Disc Console + 2 controllers - collection only!!', notes: 'Fully working, light scuff on side' });
  assert.equal(t.title, 'PS5 Disc Console + 2 controllers');
  assert.match(t.description, /Fully working, light scuff on side/);
  assert.match(t.description, /posted|post/i);
  assert.ok(t.title.length <= 80);
});

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

test('block a seller from a deal, see the list, unblock', async () => {
  const s = db.addSearch({ name: 's', keywords: 'x', sources: ['vinted'] });
  const h = db.addHit(s.id, L('z', 5, { sellerId: '9', sellerName: 'bob' }));
  db.addHit(s.id, L('z2', 5, { sellerId: '9', sellerName: 'bob' }));
  const r = await (await req('/api/blocked', { method: 'POST', body: { hitId: h.id } })).json();
  assert.equal(r.hidden, 2); // bob's other deals are hidden too
  const list = await (await req('/api/blocked')).json();
  assert.deepEqual(list.map(b => b.name), ['bob']);
  assert.equal((await req('/api/blocked', { method: 'POST', body: { hitId: db.addHit(s.id, L('n', 5)).id } })).status, 400); // no seller known
  assert.equal((await req(`/api/blocked/${list[0].id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await (await req('/api/blocked')).json()).length, 0);
});

test('insights: profit by month, where deals come from, best flips', async () => {
  const f1 = db.addFlip({ title: 'PS5', boughtPrice: 200, source: 'facebook' });
  db.updateFlip(f1.id, { soldPrice: 300, fees: 10, soldAt: '2026-10-15 12:00:00' });
  const f2 = db.addFlip({ title: 'Switch', boughtPrice: 100, source: 'vinted' });
  db.updateFlip(f2.id, { soldPrice: 140, fees: 0 });
  const i = await (await req('/api/insights')).json();
  assert.equal(i.months.length, 6);
  assert.equal(i.months.find(m => m.month === '2026-10')?.profit, 90);
  assert.ok(i.sources.find(s => s.source === 'vinted').deals >= 1);
  assert.deepEqual(i.bestFlips.map(f => f.title), ['PS5', 'Switch']);
});

test('blocked sellers are kept in backups and restored once', async () => {
  db.blockSeller({ source: 'ebay', name: 'backup_me' });
  const backup = await (await req('/api/backup')).json();
  assert.ok(backup.blockedSellers.some(b => b.name === 'backup_me'));
  const n = db.listBlocked().length;
  await req('/api/restore', { method: 'POST', body: { searches: [], flips: [], blockedSellers: backup.blockedSellers } });
  assert.equal(db.listBlocked().length, n); // already there: not duplicated
  const fresh = openDb(':memory:');
  assert.equal(fresh.listBlocked().length, 0);
});
