import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createNotifier, formatPush, formatSummary, linkTelegram } from '../src/notify.js';

const L = (id, price, title = 'Switch') => ({ source: 'vinted', id, title, price, url: 'https://www.vinted.co.uk/items/' + id, image: 'https://img/' + id, location: null, postedAt: null });

function setup(settings = {}) {
  const db = openDb(':memory:');
  db.setSettings(settings);
  const posts = [];
  const fetchFn = async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const pushes = [];
  const webpush = { setVapidDetails() {}, async sendNotification(_s, p) { pushes.push(JSON.parse(p)); } };
  db.addSubscription({ endpoint: 'e', keys: {} });
  const notify = createNotifier({ db, config: { vapidPublicKey: 'p', vapidPrivateKey: 'k', vapidSubject: 'mailto:a@b.c' }, webpush, fetchFn, now: () => '12:00', sourceLabel: () => 'Vinted' });
  return { db, posts, pushes, notify };
}

test('hot deals get a fire prefix', () => {
  assert.match(formatPush({ name: 's' }, { id: 1, listing: L('1', 40), estimate: { value: 100, profit: 56, score: 60 } }).title, /^🔥 £40/);
  assert.match(formatPush({ name: 's' }, { id: 1, listing: L('1', 40), estimate: { value: 60, profit: 16, score: 40 } }).title, /^£40/);
});

test('summary lists the best deals first', () => {
  const hits = [
    { id: 1, listing: L('1', 50, 'A'), estimate: { profit: 5, score: 10, value: 60 } },
    { id: 2, listing: L('2', 40, 'B'), estimate: { profit: 50, score: 80, value: 90 } },
    { id: 3, listing: L('3', 30, 'C'), estimate: null },
    { id: 4, listing: L('4', 20, 'D'), estimate: { profit: 20, score: 50, value: 40 } },
  ];
  const s = formatSummary({ name: 'Switch flips' }, hits);
  assert.equal(s.title, '4 new deals · Switch flips');
  assert.match(s.body, /^£40 B · £20 D · £50 A/);
  assert.equal(s.items.length, 4);
  assert.equal(s.url, '/');
});

test('sends to Discord and Telegram when configured', async () => {
  const { posts, pushes, notify } = setup({ discordWebhook: 'https://discord.com/api/webhooks/1/x', telegramBotToken: '123:AB', telegramChatId: '42' });
  await notify({ name: 'S' }, { id: 1, listing: L('9', 40, 'Switch Lite'), estimate: null });
  assert.equal(pushes.length, 1);
  const discord = posts.find(p => p.url.startsWith('https://discord.com/'));
  assert.equal(discord.body.embeds[0].url, 'https://www.vinted.co.uk/items/9');
  assert.match(discord.body.embeds[0].title, /£40 · Switch Lite/);
  const tg = posts.find(p => p.url === 'https://api.telegram.org/bot123:AB/sendPhoto'); // the listing has a photo
  assert.equal(tg.body.chat_id, '42');
  assert.match(tg.body.caption, /Switch Lite/);
  assert.equal(tg.body.reply_markup.inline_keyboard[0].at(-1).url, 'https://www.vinted.co.uk/items/9');
});

test('quiet hours silence every channel', async () => {
  const { posts, pushes, notify } = setup({ quietStart: '11:00', quietEnd: '13:00', discordWebhook: 'https://discord.com/api/webhooks/1/x' });
  await notify({ name: 'S' }, { id: 1, listing: L('9', 40), estimate: null });
  assert.equal(posts.length + pushes.length, 0);
});

test('batch: 3 or fewer go out one by one, more become one summary', async () => {
  const { pushes, notify } = setup();
  const hits = (n) => Array.from({ length: n }, (_, i) => ({ id: i, listing: L(String(i), 10 + i), estimate: null }));
  await notify.batch({ name: 'S' }, hits(3));
  assert.equal(pushes.length, 3);
  await notify.batch({ name: 'S' }, hits(5));
  assert.equal(pushes.length, 4);
  assert.match(pushes[3].title, /^5 new deals/);
});

test('a failing channel does not stop the others', async () => {
  const { db, pushes } = setup({ discordWebhook: 'https://discord.com/api/webhooks/1/x' });
  const webpush = { setVapidDetails() {}, async sendNotification(_s, p) { pushes.push(JSON.parse(p)); } };
  const notify = createNotifier({ db, config: { vapidPublicKey: 'p', vapidPrivateKey: 'k', vapidSubject: 'mailto:a@b.c' }, webpush, fetchFn: async () => { throw new Error('down'); }, now: () => '12:00' });
  await notify({ name: 'S' }, { id: 1, listing: L('9', 40), estimate: null });
  assert.equal(pushes.length, 1);
});

test('linkTelegram finds the chat that messaged the bot', async () => {
  const db = openDb(':memory:');
  db.setSettings({ telegramBotToken: '123:AB' });
  const fetchFn = async (url) => {
    assert.equal(url, 'https://api.telegram.org/bot123:AB/getUpdates');
    return { ok: true, json: async () => ({ ok: true, result: [{ message: { text: '/start', chat: { id: 1, type: 'private' } } }, { message: { text: '/start', chat: { id: 777, type: 'private', first_name: 'Me' } } }] }) };
  };
  assert.equal(await linkTelegram(db, fetchFn), '777');
  assert.equal(db.getSettings().telegramChatId, '777');
});

test('linkTelegram explains when nobody has messaged the bot yet', async () => {
  const db = openDb(':memory:');
  db.setSettings({ telegramBotToken: '123:AB' });
  await assert.rejects(linkTelegram(db, async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) })), /Send \/start to your bot/);
});
