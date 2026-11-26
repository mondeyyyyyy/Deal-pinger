import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, matches, inQuietHours } from '../src/match.js';
import { estimate, median, parseSold } from '../src/comps.js';
import fs from 'node:fs';

const L = (title, price) => ({ source: 'ebay', id: '1', title, price, url: '', image: null, location: null, postedAt: null });
const S = (o = {}) => ({ keywords: 'nintendo switch', excludeWords: '', minPrice: null, maxPrice: null, ...o });

test('parsePrice', () => {
  assert.equal(parsePrice('$1,250.00'), 1250);
  assert.equal(parsePrice('Free'), 0);
  assert.equal(parsePrice('US $45'), 45);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(undefined), null);
  assert.equal(parsePrice(30), 30);
});

test('matches requires every keyword', () => {
  assert.equal(matches(L('Nintendo Switch OLED', 200), S()), true);
  assert.equal(matches(L('Nintendo DS', 50), S()), false);
});

test('matches respects price bounds and passes unknown price', () => {
  assert.equal(matches(L('nintendo switch', 400), S({ maxPrice: 300 })), false);
  assert.equal(matches(L('nintendo switch', 20), S({ minPrice: 50 })), false);
  assert.equal(matches(L('nintendo switch', null), S({ maxPrice: 300 })), true);
});

test('excluded words block a match', () => {
  assert.equal(matches(L('Nintendo Switch BROKEN for parts', 50), S({ excludeWords: 'broken, box only' })), false);
  assert.equal(matches(L('Nintendo Switch box only', 50), S({ excludeWords: 'broken, box only' })), false);
  assert.equal(matches(L('Nintendo Switch great shape', 50), S({ excludeWords: 'broken, box only' })), true);
});

test('quiet hours handle overnight windows', () => {
  const s = { quietStart: '23:00', quietEnd: '07:00' };
  assert.equal(inQuietHours(s, '23:30'), true);
  assert.equal(inQuietHours(s, '06:59'), true);
  assert.equal(inQuietHours(s, '12:00'), false);
  assert.equal(inQuietHours({ quietStart: null, quietEnd: null }, '02:00'), false);
  assert.equal(inQuietHours({ quietStart: '13:00', quietEnd: '14:00' }, '13:30'), true);
});

test('estimate math', () => {
  const e = estimate({ shipEstimate: 12 }, L('x', 100), [190, 200, 210]);
  assert.equal(e.value, 200);
  assert.equal(e.profit, 61.5);
  assert.ok(e.score > 0 && e.score <= 100);
  assert.equal(estimate({ shipEstimate: 12 }, L('x', null), [200]), null);
  assert.equal(estimate({ shipEstimate: 12 }, L('x', 100), []), null);
  assert.equal(estimate({ shipEstimate: 12 }, L('x', 300), [200]).score, 0);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test('parseSold pulls sold prices from eBay results page', () => {
  const html = fs.readFileSync(new URL('./fixtures/ebay-sold.html', import.meta.url), 'utf8');
  assert.deepEqual(parseSold(html), [180, 210.5]);
});
