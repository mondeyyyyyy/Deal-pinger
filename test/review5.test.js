import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { maybeSendDigest } from '../src/digest.js';
import { createNotifier } from '../src/notify.js';
import { runSourceOnce, startPoller } from '../src/poller.js';
import { matches } from '../src/match.js';

const L = (id, price, title = 'ps5') => ({ source: 'v', id, title, price, url: 'https://x/' + id, image: null, location: null, postedAt: null });

test('a summary due during quiet hours is sent when they end, not lost', async () => {
  const db = openDb(':memory:');
  db.setSettings({ quietStart: '23:00', quietEnd: '08:00', digestTime: '07:30', discordWebhook: 'https://discord.com/api/webhooks/1/x' });
  let clock = '07:31';
  const posts = [];
  const notify = createNotifier({ db, config: {}, webpush: { setVapidDetails() {} }, now: () => clock, log: {}, fetchFn: async (_u, o) => { posts.push(o.body); return { ok: true }; } });
  await maybeSendDigest(db, notify, { hhmm: clock, date: '2026-11-27' });
  assert.equal(posts.length, 0);
  clock = '08:01';
  await maybeSendDigest(db, notify, { hhmm: clock, date: '2026-11-27' });
  assert.equal(posts.length, 1);
});

test('with a profit minimum, a CeX-only estimate (auto match) does not drop the deal', async () => {
  const db = openDb(':memory:');
  db.setSettings({ scamFilter: 'off' });
  const s = db.addSearch({ name: 's', keywords: 'ps5', sources: ['v'], minProfit: 30 });
  let feed = [L('seed', 100)];
  const sent = [];
  const deps = { db, ctx: {}, compsWaitMs: 20, notify: async (_s, h) => sent.push(h), getSoldPrices: async () => { throw new Error('slow'); },
    getCex: async () => ({ name: 'PS5', sell: 120, cash: 80, voucher: 90, url: 'https://cex', pinned: false }), sources: { v: { search: async () => feed } } };
  await runSourceOnce(s, 'v', deps);
  feed = [...feed, L('new', 100)];
  await runSourceOnce(db.getSearch(s.id), 'v', deps);
  assert.equal(sent.length, 1);
});

test('skip words also catch plurals ("spare" hides "spares or repairs")', () => {
  assert.equal(matches({ title: 'PS5 spares or repairs' }, { keywords: 'ps5', excludeWords: 'spare, repair' }), false);
  assert.equal(matches({ title: 'PS5 boxes' }, { keywords: 'ps5', excludeWords: 'box' }), false);
  assert.equal(matches({ title: 'PS5 unlocked' }, { keywords: 'ps5', excludeWords: 'locked' }), true);
});

test('an outage warning held back by quiet hours is sent afterwards, before any "working again"', async () => {
  const db = openDb(':memory:');
  let fail = true;
  const msgs = [];
  let quiet = true;
  const notify = async () => {};
  notify.info = async (p) => { if (quiet) return 0; msgs.push(p.title); return 1; };
  db.addSearch({ name: 's', keywords: 'a', sources: ['fb'], intervalSec: 60 });
  let now = 0;
  const p = startPoller({ db, ctx: {}, notify, getSoldPrices: async () => [], sources: { fb: { label: 'Facebook', search: async () => { if (fail) throw new Error('403'); return []; } } } },
    { tickMs: 3600000, now: () => now, jitter: 0, log: {} });
  const step = async (min) => { now = min * 60000; p.tick(); await new Promise(r => setTimeout(r, 5)); };
  for (const m of [1, 20, 35]) await step(m);
  quiet = false;
  await step(40);
  fail = false;
  await step(45);
  await p.stop();
  assert.deepEqual(msgs, ["Facebook isn't working", 'Facebook is working again']);
});
