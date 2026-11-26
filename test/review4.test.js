import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSourceOnce } from '../src/poller.js';
import { createNotifier, formatSummary } from '../src/notify.js';
import { matches } from '../src/match.js';
import * as ebay from '../src/sources/ebay.js';
import { buildDigest } from '../src/digest.js';
import { loadConfig } from '../src/config.js';

const L = (id, price, title = 'iphone 15 pro', extra = {}) => ({ source: 'v', id, title, price, url: 'https://x/' + id, image: null, location: null, postedAt: null, ...extra });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function setup({ comps, minProfit, filter } = {}) {
  const db = openDb(':memory:');
  if (filter) db.setSettings({ scamFilter: filter });
  const s = db.addSearch({ name: 's', keywords: 'iphone 15 pro', sources: ['v'], ...(minProfit != null ? { minProfit } : {}) });
  const t = { db, s, feed: [L('seed', 600)], sent: [] };
  t.deps = { db, ctx: {}, compsWaitMs: 50, notify: async (_s, h) => t.sent.push(h), getSoldPrices: comps,
    sources: { v: { search: async () => t.feed, sellerInfo: async () => ({ ratings: 0 }) } } };
  return t;
}

test('1: in hide mode, a slow price lookup is waited for so scams are still caught', async () => {
  const t = setup({ comps: () => sleep(300).then(() => [650]) });
  await runSourceOnce(t.s, 'v', t.deps);
  t.feed = [...t.feed, L('scam', 150)];
  await runSourceOnce(t.s, 'v', t.deps);
  assert.equal(t.sent.length, 0);
  assert.equal(t.db.recentHits(10, { status: 'flagged' }).length, 1);
});

test('2: with a profit minimum, unknown profit alerts instead of being dropped forever', async () => {
  const t = setup({ comps: async () => { throw new Error('ebay down'); }, minProfit: 50, filter: 'off' });
  await runSourceOnce(t.s, 'v', t.deps);
  t.feed = [...t.feed, L('x', 450)];
  await runSourceOnce(t.s, 'v', t.deps);
  assert.equal(t.sent.length, 1);
});

test('3: an empty first check followed by a full page seeds silently (site was blocked)', async () => {
  const t = setup({ comps: async () => [], filter: 'off' });
  t.feed = [];
  await runSourceOnce(t.s, 'v', t.deps);
  t.feed = Array.from({ length: 20 }, (_, i) => L('old' + i, 500));
  await runSourceOnce(t.s, 'v', t.deps);
  assert.equal(t.sent.length, 0);
  t.feed = [...t.feed, L('new', 500)];
  await runSourceOnce(t.s, 'v', t.deps);
  assert.equal(t.sent.length, 1);
});

test('5: push summaries stay well under the 4KB push limit', async () => {
  const db = openDb(':memory:');
  db.addSubscription({ endpoint: 'e', keys: {} });
  const sizes = [];
  const notify = createNotifier({ db, config: { vapidPublicKey: 'p', vapidPrivateKey: 'k', vapidSubject: 'mailto:a@b.c' }, now: () => '12:00', log: {},
    webpush: { setVapidDetails() {}, async sendNotification(_s, p) { sizes.push(Buffer.byteLength(p)); } }, fetchFn: async () => ({ ok: true }) });
  const hits = Array.from({ length: 30 }, (_, i) => ({ id: i, listing: L(String(i), 100, 'A very long listing title for a PlayStation 5 bundle with games and extras '.repeat(2)), estimate: null }));
  await notify.batch({ name: 'PS5' }, hits);
  assert.ok(sizes[0] < 3000, `payload ${sizes[0]} bytes`);
});

test('6: skip words match whole words ("locked" does not hide "unlocked")', () => {
  const s = { keywords: 'iphone 14', excludeWords: 'icloud locked, locked, case only' };
  assert.equal(matches({ title: 'iPhone 14 128GB Unlocked boxed with case' }, s), true);
  assert.equal(matches({ title: 'iPhone 14 iCloud locked' }, s), false);
  assert.equal(matches({ title: 'iPhone 14 - locked to EE' }, s), false);
});

test('7: eBay website fallback asks for Buy It Now only and offers checkout', () => {
  assert.match(ebay.buildHtmlUrl({ keywords: 'ps5' }), /LH_BIN=1/);
  const [l] = ebay.parseHtml('<li class="s-card"><a href="https://www.ebay.co.uk/itm/123"><div class="s-card__title"><span>PS5</span></div></a><span class="s-card__price">£300.00</span></li>', { bin: true });
  assert.match(l.buyUrl, /pay\.ebay\.co\.uk\/rxo.*item=123/);
});

test('digest counts only deals you can still see', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['v'] });
  db.addHit(s.id, L('a', 1), null);
  db.addHit(s.id, L('b', 1), null, 'dismissed');
  assert.equal(buildDigest(db).title, 'Today: 1 deal');
});

test('a price drop replaces the earlier card for the same listing (saved ones are kept)', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['v'] });
  db.addHit(s.id, L('a', 100));
  db.addHit(s.id, L('a', 80, 'iphone', { previousPrice: 100 }));
  assert.equal(db.recentHits().length, 1);
  assert.equal(db.recentHits()[0].listing.price, 80);
  assert.ok(db.getHit(db.recentHits()[0].id));
});

test('recentHits can filter by status in the database', () => {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'x', keywords: 'x', sources: ['v'] });
  const h = db.addHit(s.id, L('a', 1));
  db.setHitStatus(h.id, 'saved');
  for (let i = 0; i < 5; i++) db.addHit(s.id, L('n' + i, 1));
  assert.deepEqual(db.recentHits(2, { status: 'saved' }).map(x => x.id), [h.id]);
});

test('quiet hours: outage/info messages wait, and you get one "N deals during quiet hours" message after', async () => {
  const db = openDb(':memory:');
  db.setSettings({ quietStart: '23:00', quietEnd: '07:00', discordWebhook: 'https://discord.com/api/webhooks/1/x' });
  let clock = '02:00';
  const posts = [];
  const notify = createNotifier({ db, config: {}, webpush: { setVapidDetails() {} }, now: () => clock, log: {}, fetchFn: async (_u, o) => { posts.push(JSON.parse(o.body)); return { ok: true }; } });
  await notify.info({ title: 'Facebook isn\'t working', body: 'x' });
  await notify.batch({ name: 'S' }, [{ id: 1, listing: L('1', 5), estimate: null }, { id: 2, listing: L('2', 5), estimate: null }]);
  assert.equal(posts.length, 0);
  await notify.afterQuiet();
  assert.equal(posts.length, 0);
  clock = '07:01';
  await notify.afterQuiet();
  await notify.afterQuiet();
  assert.equal(posts.length, 1);
  assert.match(posts[0].embeds[0].title, /2 deals came in during quiet hours/);
});

test('bad BROWSER_CONCURRENCY falls back to 2', () => {
  assert.equal(loadConfig({ BROWSER_CONCURRENCY: 'abc', APP_PASSWORD: 'x' }).browserConcurrency, 2);
});
