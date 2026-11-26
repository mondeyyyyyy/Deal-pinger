import { matches } from './match.js';
import { buildEstimate } from './comps.js';
import { assessScam } from './scam.js';

const SOURCE_TIMEOUT_MS = 120000;
const COMPS_WAIT_MS = 2500;
const SELLER_WAIT_MS = 3000; // seller-rating lookup for suspiciously cheap listings // never hold an alert longer than this for a sold-price lookup
const PRICE_DROP_FRACTION = 0.05; // alert again when a seen listing gets at least 5% cheaper
const PRUNE_EVERY_MS = 3600 * 1000;
const WARM_EVERY_MS = 6 * 3600 * 1000;
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
    listings = await withTimeout(src.search(search, ctx), SOURCE_TIMEOUT_MS, sourceId);
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
  const matching = listings.filter(l => matches(l, search));
  const drops = db.priceDrops(search.id, matching, PRICE_DROP_FRACTION);
  const fresh = db.markSeen(search.id, matching);
  if (firstRun) {
    db.markSeeded(search.id, sourceId);
    return { newHits: [], error: null };
  }
  const alerts = [...fresh, ...drops.map(d => ({ ...d.listing, previousPrice: d.previousPrice }))];
  if (!alerts.length) return { newHits: [], error: null };

  // Sold prices (12h cache) and CeX prices (24h cache) are looked up together. If either is slow,
  // alert without it rather than wait; the lookup finishes in the background and is cached.
  const wait = deps.compsWaitMs ?? COMPS_WAIT_MS;
  const capped = (p) => withTimeout(p.catch(() => null), wait, 'lookup').catch(() => null);
  const [prices, cex] = await Promise.all([
    search.resaleOverride == null ? capped(getSoldPrices(search.keywords)) : Promise.resolve([]),
    deps.getCex ? capped(deps.getCex(search)) : Promise.resolve(null),
  ]);
  const { feePct, scamFilter } = db.getSettings();
  const newHits = [];
  const toAlert = [];
  for (const listing of alerts) {
    const est = buildEstimate(search, listing, { prices, cex, feePct });
    // Only suspiciously cheap listings cost an extra request to look up the seller's ratings.
    const ref = est?.refValue;
    if (src.sellerInfo && !listing.seller && ref && listing.price != null && listing.price <= ref * 0.6) {
      listing.seller = await withTimeout(src.sellerInfo(listing, ctx), SELLER_WAIT_MS, 'seller').catch(() => null);
    }
    listing.scam = assessScam(listing, { value: ref ?? null });
    const hidden = scamFilter !== 'off' && scamFilter !== 'flag' && listing.scam.risk === 'high';
    const hit = db.addHit(search.id, listing, est, hidden ? 'flagged' : 'new');
    newHits.push(hit);
    const worthIt = search.minProfit == null || (est && est.bestProfit >= search.minProfit);
    if (worthIt && !hidden) toAlert.push(hit);
  }
  if (toAlert.length) {
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
        for (const s of searches) {
          // Keyed on what the lookups depend on, so editing keywords or the CeX item warms straight away.
          const wkey = `${s.id}|${s.keywords}|${s.cexBoxId ?? ''}|${s.cexMode ?? ''}`;
          if (now() - (lastWarm.get(wkey) ?? -Infinity) < WARM_EVERY_MS) continue;
          lastWarm.set(wkey, now());
          Promise.resolve().then(() => deps.warm(s)).catch(() => {});
        }
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
