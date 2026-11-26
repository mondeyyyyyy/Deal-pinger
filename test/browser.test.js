import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeCards, closeBrowser, contextCount } from '../src/browser.js';

after(closeBrowser);

const page = (body) => 'data:text/html,' + encodeURIComponent(body);

test('reads image links even though image downloads are blocked, including lazy images', async () => {
  const html = page(`
    <a href="/item/1"><img src="https://img.example/1.jpg" alt="One"><div>£5</div></a>
    <a href="/item/2"><img src="data:image/gif;base64,R0lGOD" data-src="https://img.example/2.jpg" alt="Two"></a>
    <a href="/item/3"><img srcset="https://img.example/3-small.jpg 1x, https://img.example/3.jpg 2x"></a>`);
  const cards = await scrapeCards({ proxyUrl: '' }, html, 'a[href*="/item/"]', { key: 'test' });
  assert.deepEqual(cards.map(c => c.img), ['https://img.example/1.jpg', 'https://img.example/2.jpg', 'https://img.example/3-small.jpg']);
  assert.match(cards[0].text, /£5/);
});

test('reuses one warm browser session per marketplace', async () => {
  const html = page('<a href="/item/9">x</a>');
  await scrapeCards({ proxyUrl: '' }, html, 'a', { key: 'siteA' });
  await scrapeCards({ proxyUrl: '' }, html, 'a', { key: 'siteA' });
  await scrapeCards({ proxyUrl: '' }, html, 'a', { key: 'siteB' });
  assert.equal(contextCount(), 3); // test + siteA + siteB
});
