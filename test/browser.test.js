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
  const cards = await scrapeCards({ proxyUrl: '' }, html, 'a[href*="/item/"]', { key: 'test', waitMs: 1500 });
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

test('a login wall or captcha with no listings is reported as blocked, not as 0 results', async () => {
  const wall = page('<title>Log in to Facebook</title><form><input name="email"></form>');
  await assert.rejects(scrapeCards({ proxyUrl: '' }, wall, 'a[href*="/item/"]', { key: 'test', waitMs: 1500 }), /blocked|log ?in/i);
  const captcha = page('<title>Just a moment...</title><div id="challenge-form">Checking your browser</div>');
  await assert.rejects(scrapeCards({ proxyUrl: '' }, captcha, 'a[href*="/item/"]', { key: 'test', waitMs: 1500 }), /blocked|captcha|check/i);
  const empty = page('<title>Search results</title><p>No results for "zzz"</p>');
  assert.equal((await scrapeCards({ proxyUrl: '' }, empty, 'a[href*="/item/"]', { key: 'test', waitMs: 1500 })).length, 0);
});

test('real result pages are not mistaken for blocks', async () => {
  const headerLogin = page(`<title>Marketplace search</title><header><form><input name="email"><input type="password" name="pass"></form></header>
    <div id="r"></div><script>setTimeout(() => { document.getElementById('r').innerHTML = '<a href="/item/1">£5 One</a>'; }, 300)</script>`);
  assert.equal((await scrapeCards({ proxyUrl: '' }, headerLogin, 'a[href*="/item/"]', { key: 'test', waitMs: 1500 })).length, 1);
  const recaptchaScript = page(`<title>Results</title><script src="https://www.google.com/recaptcha/api.js"></script><div id="r"></div>
    <script>setTimeout(() => { document.getElementById('r').innerHTML = '<a href="/item/2">£5 Two</a>'; }, 300)</script>`);
  assert.equal((await scrapeCards({ proxyUrl: '' }, recaptchaScript, 'a[href*="/item/"]', { key: 'test', waitMs: 1500 })).length, 1);
  const zeroWithNewsletter = page('<title>Search results</title><p>No results</p><footer><input name="email" placeholder="Newsletter"></footer>');
  assert.equal((await scrapeCards({ proxyUrl: '' }, zeroWithNewsletter, 'a[href*="/item/"]', { key: 'test', waitMs: 1500 })).length, 0);
});

test('an empty page explains itself (title and opening text), so "0 listings" can be diagnosed', async () => {
  const p = page('<title>Marketplace search</title><h1>Before you continue to Marketplace</h1><p>We use cookies to improve your experience.</p>');
  const cards = await scrapeCards({ proxyUrl: '' }, p, 'a[href*="/item/"]', { key: 'test', waitMs: 300 });
  assert.equal(cards.length, 0);
  assert.match(cards.note, /Marketplace search/);
  assert.match(cards.note, /Before you continue/);
});
