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

test('only UK marketplaces are registered', () => {
  assert.deepEqual(SOURCE_IDS, ['ebay', 'facebook', 'vinted', 'gumtree', 'depop']);
  for (const id of SOURCE_IDS) assert.equal(typeof SOURCES[id].search, 'function');
});

test('ebay browse api parse', () => {
  const ls = SOURCES.ebay.parse(JSON.parse(fx('ebay-browse.json')));
  assert.equal(ls.length, 2);
  ls.forEach(l => assertListing(l, 'ebay'));
  assert.equal(ls[0].price, 215);
  assert.equal(ls[1].price, null);
  assert.equal(ls[1].url, 'https://www.ebay.co.uk/itm/222');
});

test('ebay api request targets eBay UK in GBP', () => {
  const url = SOURCES.ebay.buildApiUrl({ keywords: 'switch', minPrice: 50, maxPrice: 150 });
  assert.match(decodeURIComponent(url), /price:\[50\.\.150\],priceCurrency:GBP/);
  assert.match(decodeURIComponent(url), /itemLocationCountry:GB/);
});

test('ebay html fallback parse uses ebay.co.uk links', () => {
  const ls = SOURCES.ebay.parseHtml(fx('ebay-search.html'));
  assert.equal(ls.length, 1);
  assertListing(ls[0], 'ebay');
  assert.equal(ls[0].url, 'https://www.ebay.co.uk/itm/365550001111');
  assert.equal(ls[0].price, 149.99);
});

test('facebook cards in pounds', () => {
  const ls = SOURCES.facebook.parse(cards.facebook);
  assert.equal(ls.length, 2);
  ls.forEach(l => assertListing(l, 'facebook'));
  assert.equal(ls[0].price, 120);
  assert.equal(ls[0].title, 'Nintendo Switch with dock');
  assert.equal(ls[0].location, 'Croydon');
  assert.equal(ls[1].price, 0);
});

test('facebook url uses the UK city and km radius', () => {
  const u = SOURCES.facebook.buildUrl({ keywords: 'switch', radius: 10 }, { facebookLocation: 'manchester' });
  assert.match(u, /facebook\.com\/marketplace\/manchester\/search\?/);
  assert.match(u, /radius=16/);
});

test('vinted api parse', () => {
  const ls = SOURCES.vinted.parse(JSON.parse(fx('vinted.json')));
  assert.equal(ls.length, 2);
  ls.forEach(l => assertListing(l, 'vinted'));
  assert.equal(ls[0].id, '4812345678');
  assert.equal(ls[0].price, 85);
  assert.equal(ls[0].image, 'https://images1.vinted.net/t/a.jpeg');
  assert.equal(ls[1].price, 20);
  assert.equal(ls[1].url, 'https://www.vinted.co.uk/items/4812345679-switch-games-bundle');
});

test('vinted api url', () => {
  const u = SOURCES.vinted.buildApiUrl({ keywords: 'switch lite', minPrice: 10, maxPrice: 90 });
  assert.match(u, /^https:\/\/www\.vinted\.co\.uk\/api\/v2\/catalog\/items\?/);
  assert.match(u, /search_text=switch\+lite/);
  assert.match(u, /order=newest_first/);
  assert.match(u, /price_from=10/);
  assert.match(u, /price_to=90/);
});

test('gumtree cards', () => {
  const ls = SOURCES.gumtree.parse(cards.gumtree);
  assert.equal(ls.length, 1);
  assertListing(ls[0], 'gumtree');
  assert.equal(ls[0].id, '1489876543');
  assert.equal(ls[0].price, 180);
  assert.equal(ls[0].title, 'Nintendo Switch OLED boxed');
  assert.equal(ls[0].location, 'Hackney, London');
  assert.equal(ls[0].url, 'https://www.gumtree.com/p/video-games-consoles/nintendo-switch-oled-boxed/1489876543');
});

test('gumtree url uses postcode and distance', () => {
  const u = SOURCES.gumtree.buildUrl({ keywords: 'switch', zip: 'SW1A 1AA', radius: 15, maxPrice: 200 });
  assert.match(u, /search_location=SW1A\+1AA/);
  assert.match(u, /distance=15/);
  assert.match(u, /max_price=200/);
  assert.match(u, /sort=date/);
});

test('depop cards: title from alt, else from the product slug; current price first', () => {
  const ls = SOURCES.depop.parse(cards.depop);
  assert.equal(ls.length, 2);
  ls.forEach(l => assertListing(l, 'depop'));
  assert.equal(ls[0].title, 'Nike Air Max 90 Trainers Uk9');
  assert.equal(ls[0].price, 45);
  assert.equal(ls[1].title, 'Ralph Lauren quarter zip navy');
  assert.equal(ls[1].price, 30);
  assert.equal(ls[1].url, 'https://www.depop.com/products/someone-ralph-lauren-quarter-zip-navy/');
});

test('parseCards dedupes repeated anchors', () => {
  const c = cards.facebook[0];
  assert.equal(parseCards([c, c], { source: 'facebook', idPattern: /\/marketplace\/item\/(\d+)/, urlFor: id => `https://www.facebook.com/marketplace/item/${id}/` }).length, 1);
});
