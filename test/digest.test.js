import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { maybeSendDigest, buildDigest } from '../src/digest.js';

function setup() {
  const db = openDb(':memory:');
  const s = db.addSearch({ name: 'PS5', keywords: 'ps5', sources: ['vinted'] });
  const L = (id, price) => ({ source: 'vinted', id, title: 'PS5 ' + id, price, url: 'https://v/' + id, image: null, location: null, postedAt: null });
  db.addHit(s.id, L('a', 150), { bestProfit: 90, score: 60 });
  db.addHit(s.id, L('b', 200), { bestProfit: 20, score: 10 });
  db.addHit(s.id, L('c', 50), null, 'flagged');
  const f = db.addFlip({ title: 'Switch', boughtPrice: 100 });
  db.updateFlip(f.id, { soldPrice: 150, fees: 5 });
  return db;
}

test('digest summarises today: deals, best deal, scams hidden, flip profit', () => {
  const d = buildDigest(setup());
  assert.equal(d.title, 'Today: 2 deals');
  assert.match(d.body, /Best: £150 PS5 a \(\+£90\)/);
  assert.match(d.body, /1 likely scam hidden/);
  assert.match(d.body, /£45 flip profit this month/);
});

test('digest is sent once a day at the chosen time, only when switched on', async () => {
  const db = setup();
  const sent = [];
  const notify = { sendRaw: async (p) => { sent.push(p); return 1; } };
  await maybeSendDigest(db, notify, { hhmm: '20:00', date: '2026-11-26' });
  assert.equal(sent.length, 0); // off by default
  db.setSettings({ digestTime: '20:00' });
  await maybeSendDigest(db, notify, { hhmm: '19:59', date: '2026-11-26' });
  await maybeSendDigest(db, notify, { hhmm: '20:00', date: '2026-11-26' });
  await maybeSendDigest(db, notify, { hhmm: '20:01', date: '2026-11-26' });
  assert.equal(sent.length, 1);
  await maybeSendDigest(db, notify, { hhmm: '20:00', date: '2026-11-27' });
  assert.equal(sent.length, 2);
});
