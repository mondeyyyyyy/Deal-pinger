import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createNotifier } from '../src/notify.js';
import { runSourceOnce } from '../src/poller.js';

const L = (id, extra = {}) => ({ source: 'vinted', id, title: 'ps5', price: 150, url: 'https://v/' + id, image: 'https://img/' + id + '.jpg', location: null, postedAt: null, buyUrl: 'https://v/buy/' + id, scam: { risk: 'low', reasons: [] }, ...extra });

function tg(responder) {
  const db = openDb(':memory:');
  db.setSettings({ telegramBotToken: '1:AB', telegramChatId: '5' });
  const calls = [];
  const notify = createNotifier({ db, config: {}, webpush: { setVapidDetails() {} }, now: () => '12:00', log: {},
    fetchFn: async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return responder(url); } });
  return { calls, notify };
}

test('Telegram deal alerts include the listing photo, with buttons', async () => {
  const { calls, notify } = tg(() => ({ ok: true }));
  await notify({ name: 'PS5' }, { id: 1, listing: L('9'), estimate: null });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sendPhoto$/);
  assert.equal(calls[0].body.photo, 'https://img/9.jpg');
  assert.ok(calls[0].body.caption.length <= 1024);
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.ok(calls[0].body.reply_markup.inline_keyboard.flat().some(b => b.text === '🛒 Buy now'));
});

test('if Telegram rejects the photo, the alert is sent as text instead', async () => {
  const { calls, notify } = tg((url) => ({ ok: !url.endsWith('/sendPhoto'), status: 400 }));
  await notify({ name: 'PS5' }, { id: 1, listing: L('9'), estimate: null });
  assert.deepEqual(calls.map(c => c.url.split('/').pop()), ['sendPhoto', 'sendMessage']);
});

test('no photo: plain text alert', async () => {
  const { calls, notify } = tg(() => ({ ok: true }));
  await notify({ name: 'PS5' }, { id: 1, listing: L('9', { image: null }), estimate: null });
  assert.match(calls[0].url, /\/sendMessage$/);
});

test('"only ping fresh listings": older listings are kept but do not ping; unknown ages still ping', async () => {
  const db = openDb(':memory:');
  db.setSettings({ scamFilter: 'off' });
  const s = db.addSearch({ name: 's', keywords: 'ps5', sources: ['v'], maxAgeMin: 30 });
  const mins = (m) => new Date(Date.now() - m * 60000).toISOString();
  let feed = [L('seed', { source: 'v' })];
  const sent = [];
  const deps = { db, ctx: {}, compsWaitMs: 20, getSoldPrices: async () => [], notify: async (_s, h) => sent.push(h.listing.id), sources: { v: { search: async () => feed } } };
  await runSourceOnce(s, 'v', deps);
  feed = [...feed, L('fresh', { source: 'v', postedAt: mins(5) }), L('old', { source: 'v', postedAt: mins(300) }), L('unknown', { source: 'v' })];
  await runSourceOnce(db.getSearch(s.id), 'v', deps);
  assert.deepEqual(sent.sort(), ['fresh', 'unknown']);
  assert.equal(db.recentHits().length, 3);
});
