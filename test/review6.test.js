import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSourceOnce, createHealth } from '../src/poller.js';
import { createApp } from '../src/server.js';
import { createNotifier } from '../src/notify.js';
import { buildEstimate } from '../src/comps.js';

const L = (id, price, extra = {}) => ({ source: 'v', id, title: 'airpods max', price, url: 'https://x/' + id, image: null, location: null, postedAt: null, ...extra });
const days = (n) => new Date(Date.now() - n * 86400000).toISOString();

function setup(searchExtra = {}, depsExtra = {}) {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 's', keywords: 'airpods max', sources: ['v'], ...searchExtra });
  const t = { db, s, feed: [L('seed', 140)], sent: [] };
  t.deps = { db, ctx: {}, compsWaitMs: 20, getSoldPrices: async () => [150], notify: async (_s, h) => t.sent.push(h.listing.id),
    sources: { v: { search: async () => t.feed } }, ...depsExtra };
  return t;
}
async function run(t, add) { await runSourceOnce(t.s, 'v', t.deps); t.feed = [...t.feed, ...add]; await runSourceOnce(t.db.getSearch(t.s.id), 'v', t.deps); }

test('1: details with ratings only still let the account-age check run', async () => {
  const t = setup();
  t.deps.sources.v.details = async () => ({ description: 'Mint', seller: { name: 'new_guy', ratings: 3 } });
  t.deps.sources.v.sellerInfo = async () => ({ name: 'new_guy', ratings: 3, joinedAt: days(2) });
  await run(t, [L('bait', 80, { sellerId: '1' })]);
  assert.equal(t.sent.length, 0);
  assert.equal(t.db.recentHits(5, { status: 'flagged' })[0]?.listing.id, 'bait');
});

test('3: empty sold prices are "unknown", so an automatic CeX match cannot silently drop a deal', async () => {
  const t = setup({ minProfit: 20 }, { getSoldPrices: async () => [], getCex: async () => ({ name: 'x', sell: 70, cash: 50, voucher: 60, url: 'https://c', pinned: false }) });
  t.db.setSettings({ scamFilter: 'off' });
  await run(t, [L('d', 100)]);
  assert.deepEqual(t.sent, ['d']);
});

test('4: price drops on older listings still ping with "fresh listings only"', async () => {
  const t = setup({ maxAgeMin: 60 }, { getSoldPrices: async () => [] });
  t.db.setSettings({ scamFilter: 'off' });
  t.feed = [L('old', 250, { postedAt: days(3) })];
  await runSourceOnce(t.s, 'v', t.deps);
  t.feed = [L('old', 180, { postedAt: days(3) })];
  await runSourceOnce(t.db.getSearch(t.s.id), 'v', t.deps);
  assert.deepEqual(t.sent, ['old']);
});

test('CeX voucher filter: a missing voucher price is unknown, not a fail', async () => {
  const t = setup({ cexFilter: 'voucher' }, { getSoldPrices: async () => [], getCex: async () => ({ name: 'x', sell: 300, cash: 200, voucher: null, url: 'https://c', pinned: true }) });
  t.db.setSettings({ scamFilter: 'off' });
  await run(t, [L('v1', 100)]);
  assert.deepEqual(t.sent, ['v1']);
});

test('estimate remembers the fee and postage it used (so the breakdown always adds up)', () => {
  const e = buildEstimate({ shipEstimate: 5 }, L('x', 100), { prices: [200], feePct: 10 });
  assert.equal(e.feePct, 10);
  assert.equal(e.ship, 5);
  assert.equal(e.profit, 200 * 0.9 - 5 - 100);
});

test('Telegram: if sending the photo fails outright, the text alert still goes', async () => {
  const db = openDb(':memory:');
  db.setSettings({ telegramBotToken: '1:A', telegramChatId: '2' });
  const urls = [];
  const notify = createNotifier({ db, config: {}, webpush: { setVapidDetails() {} }, now: () => '12:00', log: {},
    fetchFn: async (u) => { urls.push(u.split('/').pop()); if (u.endsWith('sendPhoto')) throw new Error('timeout'); return { ok: true }; } });
  const n = await notify({ name: 's' }, { id: 1, listing: { ...L('1', 5), image: 'https://img/1.jpg', scam: { risk: 'low', reasons: [] } }, estimate: null });
  assert.deepEqual(urls, ['sendPhoto', 'sendMessage']);
  assert.equal(n, 1);
});

// ---------- server ----------
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
const req = (path, { method = 'POST', body } = {}) => fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });

test('2: pausing all twice still resumes everything that was running', async () => {
  const [a, b, c] = ['a', 'b', 'c'].map(n => db.addSearch({ name: n, keywords: n, sources: ['vinted'] }));
  await req('/api/searches/pause-all');
  db.updateSearch(a.id, { enabled: true }); // switched one back on by hand
  await req('/api/searches/pause-all');
  await req('/api/searches/resume-all');
  assert.deepEqual([a, b, c].map(s => db.getSearch(s.id).enabled), [true, true, true]);
});

test('turning CeX off on a search with a CeX filter clears the filter', async () => {
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['vinted'], cexFilter: 'cash' });
  const r = await req(`/api/searches/${s.id}`, { method: 'PUT', body: { cexMode: 'off' } });
  assert.equal(r.status, 200);
  assert.equal(db.getSearch(s.id).cexFilter, null);
});
