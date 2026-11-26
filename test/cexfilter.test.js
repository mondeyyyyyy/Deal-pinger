import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSourceOnce, createHealth } from '../src/poller.js';
import { createApp } from '../src/server.js';

const L = (id, price) => ({ source: 'v', id, title: 'ps5 console', price, url: 'https://x/' + id, image: null, location: null, postedAt: null });
const CEX = { name: 'Playstation 5 Console, Disc', sell: 330, cash: 205, voucher: 250, url: 'https://uk.webuy.com/product-detail?id=1', pinned: true };

function setup(searchExtra, { cex = CEX } = {}) {
  const db = openDb(':memory:');
  db.setSettings({ scamFilter: 'off' });
  const s = db.addSearch({ name: 's', keywords: 'ps5', sources: ['v'], ...searchExtra });
  const t = { db, s, feed: [L('seed', 100)], sent: [] };
  t.deps = { db, ctx: {}, compsWaitMs: 20, getSoldPrices: async () => [], getCex: async () => cex, notify: async (_s, h) => t.sent.push(h.listing.id), sources: { v: { search: async () => t.feed } } };
  return t;
}
async function run(t, listings) {
  await runSourceOnce(t.s, 'v', t.deps);
  t.feed = [...t.feed, ...listings];
  await runSourceOnce(t.db.getSearch(t.s.id), 'v', t.deps);
}

test('CeX cash filter: only deals that make money selling to CeX for cash ping', async () => {
  const t = setup({ cexFilter: 'cash' });
  await run(t, [L('cheap', 150), L('even', 205), L('dear', 260)]);
  assert.deepEqual(t.sent, ['cheap']);
  assert.equal(t.db.recentHits().length, 3); // all still listed in the feed
});

test('CeX voucher filter with a minimum profit', async () => {
  const t = setup({ cexFilter: 'voucher', cexMinProfit: 40 });
  await run(t, [L('a', 200), L('b', 215)]); // voucher 250: +50 and +35
  assert.deepEqual(t.sent, ['a']);
});

test('CeX filter: if CeX prices are unknown the deal still pings (never silently lost)', async () => {
  const t = setup({ cexFilter: 'cash' }, { cex: null });
  await run(t, [L('x', 150)]);
  assert.deepEqual(t.sent, ['x']);
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
const req = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

test('CeX filter settings are validated', async () => {
  const ok = await (await req('/api/searches', { keywords: 'ps5', sources: ['ebay'], cexFilter: 'cash', cexMinProfit: '£10' })).json();
  assert.equal(ok.cexFilter, 'cash');
  assert.equal(ok.cexMinProfit, 10);
  assert.equal((await req('/api/searches', { keywords: 'ps5', sources: ['ebay'], cexFilter: 'gold' })).status, 400);
  assert.equal((await req('/api/searches', { keywords: 'ps5', sources: ['ebay'], cexFilter: 'cash', cexMode: 'off' })).status, 400);
  const off = await (await req('/api/searches', { keywords: 'ps5', sources: ['ebay'], cexFilter: '' })).json();
  assert.equal(off.cexFilter, null);
});
