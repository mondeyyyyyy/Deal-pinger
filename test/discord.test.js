import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createNotifier, formatPush } from '../src/notify.js';

const listing = { source: 'vinted', id: '9', title: 'PS5 Disc', price: 150, url: 'https://www.vinted.co.uk/items/9', image: 'https://img/9.jpg', location: null, postedAt: null,
  buyUrl: 'https://www.vinted.co.uk/transaction/buy/new?x=9', seller: { name: 'bob', ratings: 12 }, scam: { risk: 'low', reasons: [] } };
const estimate = { value: 260, profit: 106, cex: { name: 'PS5 Disc', sell: 330, cash: 205, voucher: 250, cashProfit: 55, voucherProfit: 100, url: 'https://uk.webuy.com/product-detail?id=1' }, bestProfit: 106, score: 70 };

function setup(settings = {}) {
  const db = openDb(':memory:');
  db.setSettings(settings);
  const posts = [];
  const notify = createNotifier({ db, config: {}, webpush: { setVapidDetails() {} }, now: () => '12:00', sourceLabel: () => 'Vinted', log: {},
    fetchFn: async (url, o) => { posts.push({ url, body: JSON.parse(o.body) }); return { ok: true }; } });
  return { db, posts, notify };
}

test('Discord pinger: rich embed with price, profit, CeX, seller and buy link, plus mention', async () => {
  const { posts, notify } = setup({ discordWebhook: 'https://discord.com/api/webhooks/1/global', discordMention: '@everyone' });
  await notify({ name: 'PS5' }, { id: 1, listing, estimate });
  const { url, body } = posts[0];
  assert.equal(url, 'https://discord.com/api/webhooks/1/global');
  assert.equal(body.content, '@everyone');
  assert.deepEqual(body.allowed_mentions, { parse: ['everyone'] });
  const e = body.embeds[0];
  assert.equal(e.url, listing.url);
  assert.equal(e.image.url, 'https://img/9.jpg');
  const f = Object.fromEntries(e.fields.map(x => [x.name, x.value]));
  assert.equal(f.Price, '£150');
  assert.match(f['eBay resale'], /£260 · \+£106/);
  assert.match(f.CeX, /cash £205 \(\+£55\)/);
  assert.match(f.Seller, /bob · 12 ratings/);
  assert.match(e.description, /\[Buy now\]\(https:\/\/www\.vinted\.co\.uk\/transaction/);
});

test('Discord: a search can ping its own channel, and roles can be mentioned', async () => {
  const { posts, notify } = setup({ discordWebhook: 'https://discord.com/api/webhooks/1/global', discordMention: '123456789012345678' });
  await notify({ name: 'PS5', discordWebhook: 'https://discord.com/api/webhooks/2/ps5' }, { id: 1, listing, estimate });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://discord.com/api/webhooks/2/ps5');
  assert.equal(posts[0].body.content, '<@&123456789012345678>');
  assert.deepEqual(posts[0].body.allowed_mentions, { roles: ['123456789012345678'] });
});

test('Discord marks likely scams in red with the reasons', async () => {
  const { posts, notify } = setup({ discordWebhook: 'https://discord.com/api/webhooks/1/g' });
  await notify({ name: 'PS5' }, { id: 1, listing: { ...listing, scam: { risk: 'high', reasons: ['seller has no ratings'] } }, estimate });
  const e = posts[0].body.embeds[0];
  assert.equal(e.color, 0xd93a3a);
  assert.match(e.fields.find(x => x.name === '⚠️ Scam check').value, /no ratings/);
});

test('Telegram: buttons to open, buy and check CeX, plus a ready-to-copy message', async () => {
  const { posts, notify } = setup({ telegramBotToken: '1:AB', telegramChatId: '5' });
  await notify({ name: 'PS5', messageTemplate: 'Hi! Is this still available? {collect}Would you take {offer}?' }, { id: 1, listing, estimate });
  const b = posts[0].body;
  const buttons = b.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map(x => x.text), ['🛒 Buy now', '🔗 Open listing', '💷 CeX']);
  assert.equal(b.parse_mode, 'HTML');
  assert.match(b.caption, /<code>Hi! Is this still available\? Would you take £130\?<\/code>/);
  assert.doesNotMatch(b.caption, /collect/i);
});

test('push text: CeX profit when there is no eBay estimate, and a scam warning', () => {
  const p = formatPush({ name: 'PS5' }, { id: 1, listing: { ...listing, scam: { risk: 'medium', reasons: ['asks for bank transfer'] } }, estimate: { ...estimate, value: null, profit: null, bestProfit: 55 } });
  assert.match(p.title, /^⚠️ /);
  assert.match(p.body, /CeX cash £205 \(\+£55\)/);
  assert.match(p.body, /asks for bank transfer/);
});

test('Telegram escapes HTML in listing titles', async () => {
  const { posts, notify } = setup({ telegramBotToken: '1:AB', telegramChatId: '5' });
  await notify({ name: 'S' }, { id: 1, listing: { ...listing, title: '<b>PS5</b> & games' }, estimate: null });
  assert.match(posts[0].body.caption, /&lt;b&gt;PS5&lt;\/b&gt; &amp; games/);
});

test('Discord shows the listing description when known (trimmed)', async () => {
  const { posts, notify } = setup({ discordWebhook: 'https://discord.com/api/webhooks/1/g' });
  await notify({ name: 'PS5' }, { id: 1, listing: { ...listing, description: 'Barely used.\n\nComes with box. '.repeat(40) }, estimate });
  const f = posts[0].body.embeds[0].fields.find(x => x.name === 'Description');
  assert.ok(f.value.length <= 300);
  assert.match(f.value, /^Barely used\. Comes with box\./);
});
