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
      b.on('disconnected', () => { browserPromise = null; });
      return b;
    }).catch(e => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

/** Open a fresh page, run fn(page), always close the context. */
export async function withPage(config, fn) {
  const browser = await getBrowser(config);
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 430, height: 932 },
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      return ['media', 'font'].includes(t) ? route.abort() : route.continue();
    });
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Load url and collect listing cards: every <a> whose href matches hrefSelector.
 * Returns raw {href, text, img, alt} objects for a source's pure parse().
 */
export async function scrapeCards(config, url, hrefSelector) {
  return withPage(config, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector(hrefSelector, { timeout: 20000 }).catch(() => {});
    await page.mouse.wheel(0, 2500).catch(() => {});
    await page.waitForTimeout(1500);
    return page.$$eval(hrefSelector, (as) => as.map((a) => {
      const img = a.querySelector('img');
      return {
        href: a.getAttribute('href') || '',
        text: a.innerText || '',
        img: img ? (img.currentSrc || img.src || '') : '',
        alt: (img && img.alt) || a.getAttribute('aria-label') || a.getAttribute('title') || '',
      };
    }));
  });
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    await b?.close().catch(() => {});
  }
}
