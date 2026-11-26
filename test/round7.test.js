import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseSoldItems, cleanSoldPrices, robustMedian } from '../src/comps.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createHealth } from '../src/poller.js';

const card = (title, price) => `<li class="s-card"><div class="s-card__title"><span>${title}</span></div><span class="s-card__price">£${price}</span></li>`;

test('sold listings are parsed with their titles', () => {
  const items = parseSoldItems(`<ul>${card('Sony PS5 Disc Console', '300.00')}${card('Shop on eBay', '20.00')}</ul>`);
  assert.deepEqual(items, [{ title: 'Sony PS5 Disc Console', price: 300 }]);
});

test('only matching, working items count towards the sold price', () => {
  const items = [
    { title: 'Sony PS5 Disc Console 825GB', price: 300 },
    { title: 'PS5 console boxed', price: 320 },
    { title: 'PS5 console - spares or repairs', price: 90 },
    { title: 'PS5 empty box only', price: 15 },
    { title: 'PS5 controller', price: 40 }, // doesn't match "ps5 console"
    { title: 'PS5 Console faulty HDMI', price: 120 },
    { title: 'PS5 console for parts not working', price: 80 },
  ];
  assert.deepEqual(cleanSoldPrices(items, 'ps5 console').sort(), [300, 320]);
});

test('robust median ignores extreme outliers', () => {
  assert.equal(robustMedian([300, 310, 305, 295, 290, 315, 300, 1, 9999, 305]), 302.5);
  assert.equal(robustMedian([100, 200, 300]), 200);
  assert.equal(robustMedian([]), null);
});

// ---------- pause all ----------
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

test('pause all, then resume only the searches that were running', async () => {
  const a = db.addSearch({ name: 'a', keywords: 'a', sources: ['vinted'] });
  const b = db.addSearch({ name: 'b', keywords: 'b', sources: ['vinted'], enabled: false }); // already paused by hand
  const p = await (await req('/api/searches/pause-all', { method: 'POST' })).json();
  assert.equal(p.paused, 1);
  assert.equal(db.getSearch(a.id).enabled, false);
  const r = await (await req('/api/searches/resume-all', { method: 'POST' })).json();
  assert.equal(r.resumed, 1);
  assert.equal(db.getSearch(a.id).enabled, true);
  assert.equal(db.getSearch(b.id).enabled, false); // stays paused
});
