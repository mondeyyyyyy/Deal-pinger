import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSourceOnce, startPoller, createHealth } from '../src/poller.js';
import { createNotifier, formatPush, formatSummary, linkTelegram } from '../src/notify.js';
import * as vinted from '../src/sources/vinted.js';

const L = (id, price = 50, title = 'iphone 13') => ({ source: 'a', id, title, price, url: 'https://x/' + id, image: null, location: null, postedAt: null });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('I1: listings still being returned are never pruned and never re-alert', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['a'] });
  db.markSeen(s.id, [L('live'), L('gone')]);
  db.raw.prepare("UPDATE seen SET seenAt = datetime('now','-50 days'), lastSeenAt = datetime('now','-50 days')").run();
  assert.equal(db.markSeen(s.id, [L('live')]).length, 0); // refreshes lastSeenAt
  db.prune({ seenDays: 45 });
  assert.equal(db.markSeen(s.id, [L('live')]).length, 0);
  assert.equal(db.markSeen(s.id, [L('gone')]).length, 1);
});

test('I2: an edit made while a check is in flight discards that check', async () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'iphone', sources: ['a'] });
  let editDuringFetch = false;
  let feed = [L('1', 50, 'iphone 13')];
  const sent = [];
  const deps = { db, ctx: {}, getSoldPrices: async () => [], health: createHealth(), notify: async (_s, h) => sent.push(h),
    sources: { a: { search: async () => { if (editDuringFetch) { db.updateSearch(s.id, { keywords: 'ps5' }); editDuringFetch = false; } return feed; } } } };
  await runSourceOnce(s, 'a', deps); // seeds under "iphone"
  editDuringFetch = true;
  feed = [L('1', 50, 'iphone 13'), ...Array.from({ length: 8 }, (_, i) => L('p' + i, 50, 'ps5 console'))];
  await runSourceOnce(s, 'a', deps); // edited mid-fetch: must be discarded
  await runSourceOnce(db.getSearch(s.id), 'a', deps); // first real run under "ps5": seeds silently
  assert.equal(sent.length, 0);
});

test('I2/M2: a search deleted mid-check records and alerts nothing', async () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['a'] });
  let del = false;
  const sent = [];
  const deps = { db, ctx: {}, getSoldPrices: async () => [], notify: async (_s, h) => sent.push(h),
    sources: { a: { search: async () => { if (del) db.deleteSearch(s.id); return [L('1', 5, 'x'), L('2', 5, 'x')]; } } } };
  await runSourceOnce(s, 'a', { ...deps, sources: { a: { search: async () => [L('1', 5, 'x')] } } });
  del = true;
  await runSourceOnce(s, 'a', deps);
  assert.equal(sent.length, 0);
  assert.equal(db.recentHits().length, 0);
});

test('M2: a paused search waiting for its lane is skipped by the timer', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const slow = { lane: 'browser', search: async () => { calls++; await sleep(40); return []; } };
  const a = db.addSearch({ name: 'a', keywords: 'a', sources: ['s'] });
  const b = db.addSearch({ name: 'b', keywords: 'b', sources: ['s'] });
  const p = startPoller({ db, sources: { s: slow }, ctx: {}, notify: async () => {}, getSoldPrices: async () => [] }, { tickMs: 3600000, lanes: { fetch: 1, browser: 1 }, log: {} });
  db.updateSearch(b.id, { enabled: false }); // b is queued behind a
  await sleep(120);
  await p.stop();
  assert.equal(calls, 1);
  assert.ok(a.id);
});

test('M3: shortening a search interval takes effect without waiting for the old timer', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const s = db.addSearch({ name: 'a', keywords: 'a', sources: ['f'], intervalSec: 300 });
  let now = 0;
  const p = startPoller({ db, sources: { f: { search: async () => { calls++; return []; } } }, ctx: {}, notify: async () => {}, getSoldPrices: async () => [] },
    { tickMs: 3600000, now: () => now, jitter: 0, log: {} });
  await sleep(5);
  db.updateSearch(s.id, { intervalSec: 30 });
  now = 31000; p.tick(); await sleep(5);
  assert.equal(calls, 2);
  await p.stop();
});

test('M1: gradual price drops alert once they add up to 5%', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['a'] });
  db.markSeen(s.id, [L('1', 100)]);
  assert.equal(db.priceDrops(s.id, [L('1', 97)]).length, 0);
  const d = db.priceDrops(s.id, [L('1', 94)]);
  assert.equal(d.length, 1);
  assert.equal(d[0].previousPrice, 100);
  assert.equal(db.priceDrops(s.id, [L('1', 92)]).length, 0);
});

test('I3: Discord summaries stay under Discord limits and escape link text', async () => {
  const db = openDb(':memory:');
  db.setSettings({ discordWebhook: 'https://discord.com/api/webhooks/1/x' });
  const posts = [];
  const notify = createNotifier({ db, config: {}, webpush: { setVapidDetails() {} }, now: () => '12:00',
    fetchFn: async (url, o) => { posts.push(JSON.parse(o.body)); return { ok: true }; } });
  const long = 'Nintendo Switch OLED [boxed] (mint) with games and accessories bundle '.repeat(3);
  const hits = Array.from({ length: 12 }, (_, i) => ({ id: i, listing: { ...L(String(i), 10 + i, long), url: 'https://www.facebook.com/marketplace/item/' + '9'.repeat(16) + i + '/' }, estimate: null }));
  await notify.batch({ name: 'S' }, hits);
  const body = posts[0];
  const text = (body.content || '') + (body.embeds?.[0]?.description || '');
  assert.ok((body.content || '').length <= 2000);
  assert.ok((body.embeds?.[0]?.description || '').length <= 4096);
  assert.ok(!/\[Nintendo Switch OLED \[boxed\]/.test(text));
});

test('M7/M8: pence are formatted and each summary has its own tag', () => {
  assert.match(formatPush({ name: 's' }, { id: 1, listing: L('1', 12.5), estimate: null }).title, /£12\.50/);
  const a = formatSummary({ id: 1, name: 's' }, [{ listing: L('1'), estimate: null }]);
  const b = formatSummary({ id: 1, name: 's' }, [{ listing: L('2'), estimate: null }]);
  assert.notEqual(a.tag, b.tag);
});

test('M5: Telegram links to the latest private /start, not just the last sender', async () => {
  const db = openDb(':memory:');
  db.setSettings({ telegramBotToken: '1:AB' });
  const updates = [
    { message: { text: '/start', chat: { id: 10, type: 'private', first_name: 'Me' } } },
    { message: { text: 'hello', chat: { id: 66, type: 'private', first_name: 'Stranger' } } },
    { message: { text: '/start', chat: { id: 77, type: 'group', title: 'Group' } } },
  ];
  const r = await linkTelegram(db, async () => ({ ok: true, json: async () => ({ ok: true, result: updates }) }));
  assert.equal(r, '10');
});

test('I5: Vinted browser fallback runs in the browser lane and remembers that the API is blocked', async () => {
  vinted._resetForTests?.();
  let fetches = 0;
  const lanes = [];
  const ctx = {
    config: {},
    fetch: async () => { fetches++; return { ok: false, status: 403, headers: { getSetCookie: () => [] } }; },
    inLane: async (lane, fn) => { lanes.push(lane); return fn(); },
    withPage: async (_c, fn) => fn({ goto: async () => {}, evaluate: async () => ({ status: 200, body: { items: [{ id: 1, title: 't', price: '5', url: '/items/1' }] } }) }),
  };
  const s = { keywords: 'x' };
  assert.equal((await vinted.search(s, ctx)).length, 1);
  const before = fetches;
  assert.equal((await vinted.search(s, ctx)).length, 1);
  assert.equal(fetches, before); // skipped the blocked API on the second run
  assert.deepEqual(lanes, ['browser', 'browser']);
});
