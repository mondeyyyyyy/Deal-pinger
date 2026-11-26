import { chromium } from 'playwright';
import { UA } from './comps.js';

let browserPromise = null;

function proxyOption(proxyUrl) {
  if (!proxyUrl) return undefined;
  const u = new URL(proxyUrl);
  return {
    server: `${u.protocol}//${u.host}`,
    username: decodeURIComponent(u.username) || undefined,
    password: decodeURIComponent(u.password) || undefined,
  };
}

async function getBrowser(config) {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      proxy: proxyOption(config.proxyUrl),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }).then(b => {
      b.on('disconnected', () => { browserPromise = null; contexts.clear(); });
      return b;
    }).catch(e => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

// One warm browser context per marketplace keeps cookies and consent choices between checks,
// which makes repeat loads much faster. Contexts are recycled every RECYCLE_AFTER pages to cap memory.
const RECYCLE_AFTER = 50;
const contexts = new Map(); // key -> { promise, uses }
// We only need text and image URLs: skip downloading images, video and fonts.
const BLOCKED = new Set(['image', 'media', 'font']);

async function newContext(browser) {
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 430, height: 932 },
    isMobile: true,
  });
  await context.route('**/*', (route) => (BLOCKED.has(route.request().resourceType()) ? route.abort() : route.continue()));
  return context;
}

async function getContext(config, key) {
  const browser = await getBrowser(config);
  let entry = contexts.get(key);
  if (entry && entry.uses >= RECYCLE_AFTER) {
    // Retire it: no new pages; it closes when its last open page closes.
    contexts.delete(key);
    entry.retired = true;
    if (entry.open === 0) entry.promise.then(c => c.close()).catch(() => {});
    entry = null;
  }
  if (!entry) {
    entry = { promise: newContext(browser), uses: 0, open: 0, retired: false };
    contexts.set(key, entry);
    entry.promise.catch(() => contexts.delete(key));
  }
  entry.uses++;
  return entry;
}

export const contextCount = () => contexts.size;

/** Open a page in the marketplace's warm context (or a throwaway one), run fn(page), close the page. */
export async function withPage(config, fn, { key } = {}) {
  if (!key) {
    const context = await newContext(await getBrowser(config));
    try { return await fn(await context.newPage()); } finally { await context.close().catch(() => {}); }
  }
  const entry = await getContext(config, key);
  entry.open++;
  try {
    const page = await (await entry.promise).newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    entry.open--;
    if (entry.retired && entry.open === 0) entry.promise.then(c => c.close()).catch(() => {});
  }
}

/**
 * Load url and collect listing cards: every <a> matching hrefSelector.
 * Returns raw {href, text, img, alt} objects for a source's pure parse().
 */
export async function scrapeCards(config, url, hrefSelector, { key } = {}) {
  return withPage(config, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(hrefSelector, { timeout: 15000 }).catch(() => {});
    // No results after waiting: if the page is clearly a login wall or bot check, report it as blocked
    // (instead of "0 listings"). Only strong signals count, so a real empty results page stays empty.
    const blocked = await page.evaluate((sel) => {
      if (document.querySelector(sel)) return null;
      const head = `${document.title} ${location.pathname}`;
      const visible = (document.body?.innerText || '').slice(0, 3000);
      if (/captcha|just a moment|attention required|access denied/i.test(head) || /checking your browser|are you a robot|unusual traffic|verify you are (a )?human/i.test(visible)) return 'a bot check (captcha)';
      if (/log ?in|sign ?in|checkpoint/i.test(head)) return 'a login page';
      if (document.querySelector('input[type=password]') && visible.length < 1500) return 'a login page';
      return null;
    }, hrefSelector).catch(() => null);
    if (blocked) throw new Error(`Blocked: the site showed ${blocked} instead of results`);
    await page.mouse.wheel(0, 2500).catch(() => {});
    await page.waitForTimeout(400);
    return page.$$eval(hrefSelector, (as) => as.map((a) => {
      const img = a.querySelector('img');
      let src = '';
      if (img) {
        // Images aren't downloaded, so read the URL from attributes; lazy images keep it in data-src/srcset.
        const attr = img.getAttribute('src') || '';
        const srcset = (img.getAttribute('srcset') || img.getAttribute('data-srcset') || '').split(',')[0].trim().split(/\s+/)[0];
        src = (!attr || attr.startsWith('data:')) ? (img.getAttribute('data-src') || srcset || '') : attr;
        if (src) { try { src = new URL(src, location.href).href; } catch { src = ''; } }
      }
      return {
        href: a.getAttribute('href') || '',
        text: a.innerText || '',
        img: src,
        alt: (img && img.alt) || a.getAttribute('aria-label') || a.getAttribute('title') || '',
      };
    }));
  }, { key });
}

export async function closeBrowser() {
  contexts.clear();
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    await b?.close().catch(() => {});
  }
}
