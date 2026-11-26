import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSearchOnce, createHealth } from '../src/poller.js';
import { createNotifier } from '../src/notify.js';

const L = (source, id, price = 50, title = 'nintendo switch') => ({ source, id, title, price, url: 'https://x/' + id, image: null, location: null, postedAt: null });

function setup(extra = {}) {
  const db = openDb(':memory:');
  const search = db.addSearch({ name: 'Switch', keywords: 'switch', sources: ['a', 'b'], ...extra });
  const feeds = { a: [L('a', '1')], b: [L('b', '1')] };
  const sources = {
    a: { label: 'A', search: async () => feeds.a },
    b: { label: 'B', search: async () => { if (feeds.b === 'boom') throw new Error('blocked'); return feeds.b; } },
  };
  const sent = [];
  const notify = async (s, hit) => { sent.push(hit); };
  const deps = { db, sources, notify, ctx: {}, getSoldPrices: async () => [200], health: createHealth() };
  return { db, search, feeds, sent, deps };
}

test('first run seeds silently, second run alerts once on the new listing', async () => {
  const { db, search, feeds, sent, deps } = setup();
  const r1 = await runSearchOnce(search, deps);
  assert.equal(r1.newHits.length, 0);
  assert.equal(sent.length, 0);
  feeds.a = [L('a', '1'), L('a', '2')];
  const r2 = await runSearchOnce(search, deps);
  assert.equal(r2.newHits.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].listing.id, '2');
  assert.equal(sent[0].estimate.value, 200);
  assert.equal(db.recentHits().length, 1);
});

test('non-matching listings are ignored', async () => {
  const { search, feeds, sent, deps } = setup({ excludeWords: 'broken' });
  await runSearchOnce(search, deps);
  feeds.a = [L('a', '1'), L('a', '3', 50, 'switch broken screen'), L('a', '4', 50, 'xbox')];
  const r = await runSearchOnce(search, deps);
  assert.equal(r.newHits.length, 0);
  assert.equal(sent.length, 0);
});

test('a failing source does not block the others', async () => {
  const { search, feeds, sent, deps } = setup();
  await runSearchOnce(search, deps);
  feeds.b = 'boom';
  feeds.a = [L('a', '1'), L('a', '5')];
  const r = await runSearchOnce(search, deps);
  assert.deepEqual(r.errors, [{ source: 'b', message: 'blocked' }]);
  assert.equal(sent.length, 1);
  assert.equal(deps.health.get().b.ok, false);
  assert.equal(deps.health.get().a.ok, true);
});

test('comps failure still alerts, just without an estimate', async () => {
  const { search, feeds, sent, deps } = setup();
  deps.getSoldPrices = async () => { throw new Error('ebay down'); };
  await runSearchOnce(search, deps);
  feeds.a = [L('a', '1'), L('a', '6')];
  await runSearchOnce(search, deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].estimate, null);
});

test('minProfit suppresses the alert but keeps the hit', async () => {
  const { db, search, feeds, sent, deps } = setup({ minProfit: 100 });
  await runSearchOnce(search, deps);
  feeds.a = [L('a', '1'), L('a', '7', 150)];
  const r = await runSearchOnce(search, deps);
  assert.equal(r.newHits.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(db.recentHits().length, 1);
});

test('adding a source later seeds that source silently', async () => {
  const { db, search, feeds, sent, deps } = setup();
  db.updateSearch(search.id, { sources: ['a'] });
  await runSearchOnce(db.getSearch(search.id), deps);
  const s2 = db.updateSearch(search.id, { sources: ['a', 'b'] });
  feeds.b = [L('b', '1'), L('b', '2')];
  await runSearchOnce(s2, deps);
  assert.equal(sent.length, 0);
});

function notifierSetup(settings = {}) {
  const db = openDb(':memory:');
  db.addSubscription({ endpoint: 'good', keys: {} });
  db.addSubscription({ endpoint: 'gone', keys: {} });
  db.setSettings(settings);
  const calls = [];
  const webpush = {
    setVapidDetails() {},
    async sendNotification(sub, payload) {
      calls.push({ sub: sub.endpoint, payload: JSON.parse(payload) });
      if (sub.endpoint === 'gone') { const e = new Error('Gone'); e.statusCode = 410; throw e; }
    },
  };
  const config = { vapidPublicKey: 'p', vapidPrivateKey: 'k', vapidSubject: 'mailto:x@y.z', timezone: 'UTC' };
  return { db, calls, notify: createNotifier({ db, config, webpush, now: () => '12:00', sourceLabel: (id) => id.toUpperCase() }) };
}

const HIT = { id: 1, listing: L('ebay', '9', 80, 'Nintendo Switch'), estimate: { value: 200, profit: 61.5, score: 76 } };

test('notifier sends to all subs and drops dead (410) ones', async () => {
  const { db, calls, notify } = notifierSetup();
  await notify({ name: 'Switch' }, HIT);
  assert.equal(calls.length, 2);
  assert.match(calls[0].payload.title, /\$80/);
  assert.match(calls[0].payload.body, /\+\$61\.5 profit/);
  assert.equal(calls[0].payload.url, 'https://x/9');
  assert.deepEqual(db.listSubscriptions().map(s => s.endpoint), ['good']);
});

test('notifier is silent during quiet hours unless forced', async () => {
  const { calls, notify } = notifierSetup({ quietStart: '11:00', quietEnd: '13:00' });
  await notify({ name: 'Switch' }, HIT);
  assert.equal(calls.length, 0);
  await notify({ name: 'Switch' }, HIT, { force: true });
  assert.equal(calls.length, 2);
});
