import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SOURCES, SOURCE_IDS } from '../src/sources/index.js';
import { parseCards } from '../src/sources/cards.js';

const fx = (f) => fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8');
const cards = JSON.parse(fx('cards.json'));

function assertListing(l, source) {
  assert.equal(l.source, source);
  assert.equal(typeof l.id, 'string');
  assert.ok(l.id.length > 0);
  assert.equal(typeof l.title, 'string');
  assert.ok(l.title.length > 0);
  assert.ok(l.price === null || typeof l.price === 'number');
  assert.match(l.url, /^https:\/\//);
  for (const k of ['image', 'location', 'postedAt']) assert.ok(l[k] === null || typeof l[k] === 'string', k);
}

test('all five sources registered', () => {
  assert.deepEqual(SOURCE_IDS, ['ebay', 'craigslist', 'facebook', 'offerup', 'mercari']);
  for (const id of SOURCE_IDS) assert.equal(typeof SOURCES[id].search, 'function');
});

test('craigslist parse', () => {
  const ls = SOURCES.craigslist.parse(fx('craigslist.html'));
  assert.equal(ls.length, 2);
  ls.forEach(l => assertListing(l, 'craigslist'));
  assert.equal(ls[0].id, '7801234567');
  assert.equal(ls[0].price, 1180);
  assert.equal(ls[0].location, 'mission district');
  assert.equal(ls[1].title, 'Switch Lite & case');
  assert.equal(ls[1].price, 0);
});

test('ebay browse api parse', () => {
  const ls = SOURCES.ebay.parse(JSON.parse(fx('ebay-browse.json')));
  assert.equal(ls.length, 2);
  ls.forEach(l => assertListing(l, 'ebay'));
  assert.equal(ls[0].price, 215);
  assert.equal(ls[0].location, 'Austin, TX');
  assert.equal(ls[1].price, null);
});

test('ebay html fallback parse', () => {
  const ls = SOURCES.ebay.parseHtml(fx('ebay-search.html'));
  assert.equal(ls.length, 1);
  assertListing(ls[0], 'ebay');
  assert.equal(ls[0].id, '365550001111');
  assert.equal(ls[0].title, 'Nintendo Switch V2 Console');
  assert.equal(ls[0].price, 149.99);
});

test('facebook cards', () => {
  const ls = SOURCES.facebook.parse(cards.facebook);
  assert.equal(ls.length, 2);
  ls.forEach(l => assertListing(l, 'facebook'));
  assert.equal(ls[0].id, '1122334455667788');
  assert.equal(ls[0].url, 'https://www.facebook.com/marketplace/item/1122334455667788/');
  assert.equal(ls[0].price, 120);
  assert.equal(ls[0].title, 'Nintendo Switch with dock');
  assert.equal(ls[0].location, 'Daly City, CA');
  assert.equal(ls[1].price, 0);
});

test('offerup cards', () => {
  const [l] = SOURCES.offerup.parse(cards.offerup);
  assertListing(l, 'offerup');
  assert.equal(l.price, 180);
  assert.equal(l.title, 'Nintendo Switch OLED');
  assert.equal(l.location, 'San Jose, CA');
});

test('mercari cards take the first (current) price', () => {
  const [l] = SOURCES.mercari.parse(cards.mercari);
  assertListing(l, 'mercari');
  assert.equal(l.id, 'm81234567890');
  assert.equal(l.price, 95);
  assert.equal(l.url, 'https://www.mercari.com/us/item/m81234567890/');
});

test('parseCards dedupes repeated anchors', () => {
  const c = cards.facebook[0];
  assert.equal(parseCards([c, c], { source: 'facebook', base: 'https://www.facebook.com', idPattern: /\/marketplace\/item\/(\d+)/, urlFor: id => `https://www.facebook.com/marketplace/item/${id}/` }).length, 1);
});
