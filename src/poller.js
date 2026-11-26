import { matches, keywordVariants } from './match.js';
import { buildEstimate } from './comps.js';
import { assessScam, isBaitPrice } from './scam.js';

const SOURCE_TIMEOUT_MS = 120000;
const COMPS_WAIT_MS = 2500; // never hold an alert longer than this for sold-price / CeX lookups
const EXTRA_WAIT_MS = 8000; // extra wait when a price decides whether a deal is hidden or sent
const SELLER_WAIT_MS = 3000; // seller-rating lookups (only for suspiciously cheap listings)
const SELLER_CACHE_MS = 3600 * 1000;
const sellerCache = new Map(); // "source:sellerId" -> { at, info }
const PRICE_DROP_FRACTION = 0.05; // alert again when a seen listing gets at least 5% cheaper
const PRUNE_EVERY_MS = 3600 * 1000;
const WARM_EVERY_MS = 6 * 3600 * 1000;
const OUTAGE_ALERT_MS = 30 * 60 * 1000;
const MATCH_FIELDS = ['keywords', 'minPrice', 'maxPrice', 'excludeWords'];

export function createHealth() {
  const state = {};
  return {
    record(source, entry) { state[source] = { ...state[source], ...entry, at: new Date().toISOString() }; },
    get() { return state; },
  };
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); })])
    .finally(() => clearTimeout(t));
}

/**
 * Check one marketplace for one search. Records new listings and price drops as hits and alerts them.
 * Returns { newHits, error } where error is { source, message } or null.
 */
export async function runSourceOnce(search, sourceId, deps) {
  const { db, sources, notify, ctx, getSoldPrices, health } = deps;
  const src = sources[sourceId];
  if (!src) return { newHits: [], error: null };

  const started = Date.now();
  // Read seeding state before the (possibly slow) fetch: an edit during the fetch clears it.
  const firstRun = !db.isSeeded(search.id, sourceId);
  let listings;
  try {
    // Each "a | b" variant is its own marketplace query; merge the results.
    const variants = keywordVariants(search.keywords);
    let cancelled = false; // set on timeout so we stop opening pages after the lane slot is released
    const fetchAll = async () => {
      if (variants.length <= 1) return src.search(search, ctx);
      const seenIds = new Set();
      const merged = [];
      for (const v of variants) {
        if (cancelled) break;
        for (const l of await src.search({ ...search, keywords: v }, ctx)) {
          if (!seenIds.has(String(l.id))) { seenIds.add(String(l.id)); merged.push(l); }
        }
      }
      return merged;
    };
    listings = await withTimeout(fetchAll(), SOURCE_TIMEOUT_MS, sourceId).catch((e) => { cancelled = true; throw e; });
    health?.record(sourceId, { ok: true, count: listings.length, error: null, ms: Date.now() - started });
  } catch (e) {
    health?.record(sourceId, { ok: false, error: e.message, ms: Date.now() - started });
    return { newHits: [], error: { source: sourceId, message: e.message } };
  }

  // If the search was deleted, or its filters changed while we were fetching, these results
  // belong to the old search: drop them so the next run re-seeds silently under the new filters.
  const current = db.getSearch(search.id);
  if (!current || MATCH_FIELDS.some(k => current[k] !== search[k])) return { newHits: [], error: null };

  // Seeded = one successful fetch has happened for this source since the search's filters last changed.
  const matching = listings.filter(l => matches(l, search) && !db.isBlocked(l));
  const drops = db.priceDrops(search.id, matching, PRICE_DROP_FRACTION);
  const fresh = db.markSeen(search.id, matching);
  if (firstRun) {
    db.markSeeded(search.id, sourceId, { empty: listings.length === 0 });
    return { newHits: [], error: null };
  }
  // Seeded from an empty page: a sudden full page usually means the site was blocking us before,
  // so seed silently. A few new listings on a quiet search are genuinely new, so alert those.
  if (db.seededEmpty(search.id, sourceId)) {
    db.markSeeded(search.id, sourceId, { empty: listings.length === 0 });
    if (fresh.length > 3) return { newHits: [], error: null };
  }
  const alerts = [...fresh, ...drops.map(d => ({ ...d.listing, previousPrice: d.previousPrice }))];
  if (!alerts.length) return { newHits: [], error: null };

  // Sold prices (12h cache) and CeX prices (24h cache) are looked up together. If either is slow,
  // alert without it rather than wait; the lookup finishes in the background and is cached.
  const { feePct, scamFilter } = db.getSettings();
  const wait = deps.compsWaitMs ?? COMPS_WAIT_MS;
  const capped = (p, ms = wait) => withTimeout(p, ms, 'lookup').catch(() => null);
  const soldP = search.resaleOverride == null ? getSoldPrices(search.keywords).catch(() => null) : Promise.resolve([]);
  const cexP = deps.getCex ? deps.getCex(search).catch(() => null) : Promise.resolve(null);
  // Extra listing details (e.g. Vinted's description and seller ratings) are fetched for new deals
  // only, alongside the price lookups, so they add no extra wait.
  const detailsP = Promise.all(alerts.map((l) => (src.details ? capped(Promise.resolve().then(() => src.details(l, ctx)).catch(() => null)) : null)));
  let [prices, cex, details] = await Promise.all([capped(soldP), capped(cexP), detailsP]);
  alerts.forEach((l, i) => {
    const d = details[i];
    if (!d) return;
    if (d.description && !l.description) l.description = String(d.description).slice(0, 2000);
    if (d.seller && !l.seller) l.seller = d.seller;
  });
  // When the price decides whether a deal is hidden (scam filter) or sent (profit minimum),
  // a slow lookup is worth waiting a little longer for. Usually it's pre-loaded and instant.
  if (prices === null && (scamFilter === 'hide' || search.minProfit != null)) prices = await capped(soldP, EXTRA_WAIT_MS);
  const newHits = [];
  const toAlert = [];
  const ests = alerts.map((listing) => buildEstimate(search, listing, { prices, cex, feePct }));
  // Only suspiciously cheap listings cost an extra request to look up the seller; all at once, cached per seller.
  await Promise.all(alerts.map(async (listing, i) => {
    const ref = ests[i]?.refValue;
    if (!src.sellerInfo || listing.seller || !ref || listing.price == null) return;
    if (listing.price > ref * 0.6 && !isBaitPrice(listing.price, ref)) return;
    const key = `${sourceId}:${listing.sellerId ?? listing.id}`;
    const hit = sellerCache.get(key);
    if (hit && Date.now() - hit.at < SELLER_CACHE_MS) { listing.seller = hit.info; return; }
    try {
      listing.seller = await withTimeout(src.sellerInfo(listing, ctx), SELLER_WAIT_MS, 'seller');
      if (sellerCache.size > 2000) sellerCache.clear();
      sellerCache.set(key, { at: Date.now(), info: listing.seller });
    } catch {
      listing.sellerCheckFailed = true;
    }
  }));
  for (const [i, listing] of alerts.entries()) {
    const est = ests[i];
    listing.scam = assessScam(listing, { value: est?.refValue ?? null });
    // A listing the user marked "Not a scam" stays trusted, even if its price drops later.
    const trusted = db.cacheGet(`trust:${listing.source}:${listing.id}`, Infinity) !== undefined;
    const hidden = !trusted && scamFilter !== 'off' && scamFilter !== 'flag' && listing.scam.risk === 'high';
    const hit = db.addHit(search.id, listing, est, hidden ? 'flagged' : 'new');
    newHits.push(hit);
    // Unknown profit isn't "below the minimum": alert rather than lose the deal for good.
    // (An automatic CeX match alone isn't trusted for this: it can be the wrong model.)
    const profitKnown = est && (prices !== null || search.resaleOverride != null || est.cex?.pinned);
    const worthIt = search.minProfit == null || !profitKnown || est.bestProfit >= search.minProfit;
    // Another of your searches already sent this exact listing: keep the card, skip the second ping.
    if (worthIt && !hidden && !db.alertedElsewhere(search.id, listing)) toAlert.push(hit);
  }
  if (toAlert.length) {
    db.markAlerted(toAlert.map(h => h.id));
    if (notify.batch) await notify.batch(search, toAlert).catch(() => {});
    else for (const h of toAlert) await notify(search, h).catch(() => {});
  }
  return { newHits, error: null };
}

/** Check every source of one search, one after another. */
export async function runSearchOnce(search, deps) {
  const newHits = [];
  const errors = [];
  for (const sourceId of search.sources) {
    const r = await runSourceOnce(search, sourceId, deps);
    newHits.push(...r.newHits);
    if (r.error) errors.push(r.error);
  }
  return { newHits, errors };
}

function semaphore(max) {
  let active = 0;
  const waiters = [];
  return {
    async acquire() {
      if (active < max) { active++; return; }
      await new Promise(r => waiters.push(r));
    },
    release() {
      const next = waiters.shift();
      if (next) next(); else active--;
    },
  };
}

/**
 * Schedule checks per (search, marketplace). Each job runs on its own timer:
 * max(search.intervalSec, the marketplace's minimum). Jobs run in lanes so quick API lookups
 * (fetch lane) never queue behind slow headless-browser pages (browser lane).
 * Returns { stop, runNow(searchId), tick }.
 */
export function startPoller(deps, {
  tickMs = 1000,
  defaultIntervalSec = 60,
  lanes = { fetch: 4, browser: 2 },
  jitter = 0.1,
  now = Date.now,
  log = console,
} = {}) {
  const { db, sources } = deps;
  const laneLocks = Object.fromEntries(Object.entries(lanes).map(([k, n]) => [k, semaphore(Math.max(1, n))]));
  const running = new Map(); // "searchId:sourceId" -> promise
  let stopped = false;
  let lastPrune = -Infinity;
  const lastWarm = new Map(); // searchId -> ms

  const laneOf = (src) => laneLocks[src.lane] || laneLocks.fetch;

  // If a marketplace keeps failing (usually it's blocking the server), say so once, and again when it's back.
  const outages = new Map(); // sourceId -> { since, alerted }
  function watchOutage(sourceId, error) {
    const label = sources[sourceId]?.label || sourceId;
    const o = outages.get(sourceId);
    const notifier = deps.notify?.info || deps.notify?.sendRaw;
    const send = (payload) => Promise.resolve(notifier?.({ url: '/', ...payload })).catch(() => 0);
    if (!error) {
      if (o?.alerted) send({ title: `${label} is working again`, body: 'Deal Pinger is checking it normally.' });
      outages.delete(sourceId);
      return;
    }
    if (!o) { outages.set(sourceId, { since: now(), alerted: false }); return; }
    if (!o.alerted && !o.sending && now() - o.since >= OUTAGE_ALERT_MS) {
      o.sending = true;
      Promise.resolve(send({
        title: `${label} isn't working`,
        body: `Failing for ${Math.round((now() - o.since) / 60000)} min: ${String(error.message).slice(0, 120)}. If it says blocked/403, add a UK residential proxy as PROXY_URL in Railway.`,
      })).then((n) => { o.alerted = n !== 0; }).finally(() => { o.sending = false; }); // quiet hours: try again later
    }
  }
  // Lets a source run part of its work in another lane, e.g. Vinted's browser fallback.
  if (deps.ctx) {
    deps.ctx.inLane = async (lane, fn) => {
      const lock = laneLocks[lane] || laneLocks.fetch;
      await lock.acquire();
      try { return await fn(); } finally { lock.release(); }
    };
  }

  function runJob(searchId, sourceId, { force = false } = {}) {
    const key = `${searchId}:${sourceId}`;
    if (running.has(key)) return running.get(key);
    const src = sources[sourceId];
    const lock = laneOf(src);
    const p = (async () => {
      await lock.acquire();
      try {
        // Re-read so edits made while this job waited for its lane are respected.
        const s = db.getSearch(searchId);
        // Paused while queued: the timer skips it; "Check now" (force) still runs it.
        if (!s || !s.sources.includes(sourceId) || (!force && !s.enabled)) return { newHits: [], error: null };
        const r = await runSourceOnce(s, sourceId, deps);
        if (r.newHits.length) log.info?.(`[${s.name}] ${sourceId}: ${r.newHits.length} new`);
        if (r.error) log.warn?.(`[${s.name}] ${sourceId}: ${r.error.message}`);
        watchOutage(sourceId, r.error);
        return r;
      } catch (e) {
        log.error?.(`[${searchId}] ${sourceId}: ${e.message}`);
        return { newHits: [], error: { source: sourceId, message: e.message } };
      } finally {
        lock.release();
        running.delete(key);
      }
    })();
    running.set(key, p);
    return p;
  }

  // Interval is recomputed every tick from the search's current setting, so a shorter
  // "check every" takes effect straight away. Each run gets its own small random jitter.
  const lastStart = new Map(); // key -> ms
  const jitterOf = new Map(); // key -> factor for the current wait
  function intervalMs(search, src, context) {
    const min = typeof src.minIntervalSec === 'function' ? src.minIntervalSec(context) : (src.minIntervalSec || 0);
    return Math.max(search.intervalSec || defaultIntervalSec, min) * 1000;
  }

  function tick() {
    if (stopped) return;
    try {
      if (now() - lastPrune > PRUNE_EVERY_MS) { lastPrune = now(); db.prune(); }
      const searches = db.listSearches().filter(s => s.enabled);
      const counts = {};
      for (const s of searches) for (const id of s.sources) counts[id] = (counts[id] || 0) + 1;
      const active = new Set();
      // Pre-load sold prices and CeX prices so alerts have them instantly (caches last 12-24h).
      if (deps.warm) {
        // At most a few per tick, so startup doesn't fire every lookup at once.
        let budget = 3;
        const current = new Set();
        for (const s of searches) {
          // Keyed on what the lookups depend on, so editing keywords or the CeX item warms straight away.
          const wkey = `${s.id}|${s.keywords}|${s.cexBoxId ?? ''}|${s.cexMode ?? ''}`;
          current.add(wkey);
          if (now() - (lastWarm.get(wkey) ?? -Infinity) < WARM_EVERY_MS || budget <= 0) continue;
          budget--;
          lastWarm.set(wkey, now());
          Promise.resolve().then(() => deps.warm(s)).catch(() => {});
        }
        for (const k of lastWarm.keys()) if (!current.has(k)) lastWarm.delete(k);
      }
      for (const s of searches) {
        for (const sourceId of s.sources) {
          const src = sources[sourceId];
          if (!src) continue;
          const key = `${s.id}:${sourceId}`;
          active.add(key);
          if (running.has(key)) continue;
          const wait = intervalMs(s, src, { searchCount: counts[sourceId], config: deps.ctx?.config }) * (jitterOf.get(key) ?? 1);
          if (lastStart.has(key) && now() - lastStart.get(key) < wait) continue;
          lastStart.set(key, now());
          jitterOf.set(key, 1 + Math.random() * jitter);
          runJob(s.id, sourceId);
        }
      }
      // Forget timers for deleted or paused searches.
      for (const key of lastStart.keys()) if (!active.has(key)) { lastStart.delete(key); jitterOf.delete(key); }
    } catch (e) {
      log.error?.(`scheduler error: ${e.message}`);
    }
  }

  const timer = setInterval(tick, tickMs);
  tick();

  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.allSettled([...running.values()]);
    },
    async runNow(searchId) {
      const s = db.getSearch(searchId);
      if (!s) return null;
      const results = await Promise.all(s.sources.filter(id => sources[id]).map(id => runJob(s.id, id, { force: true })));
      return {
        newHits: results.flatMap(r => r.newHits),
        errors: results.map(r => r.error).filter(Boolean),
      };
    },
  };
}
