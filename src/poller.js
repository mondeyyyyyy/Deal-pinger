import { matches } from './match.js';
import { estimate } from './comps.js';

const SOURCE_TIMEOUT_MS = 120000;
const COMPS_WAIT_MS = 2500; // never hold an alert longer than this for a sold-price lookup
const PRICE_DROP_FRACTION = 0.05; // alert again when a seen listing gets at least 5% cheaper
const PRUNE_EVERY_MS = 3600 * 1000;

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
  let listings;
  try {
    listings = await withTimeout(src.search(search, ctx), SOURCE_TIMEOUT_MS, sourceId);
    health?.record(sourceId, { ok: true, count: listings.length, error: null, ms: Date.now() - started });
  } catch (e) {
    health?.record(sourceId, { ok: false, error: e.message, ms: Date.now() - started });
    return { newHits: [], error: { source: sourceId, message: e.message } };
  }

  // Seeded = one successful fetch has happened for this source since the search's filters last changed.
  const firstRun = !db.isSeeded(search.id, sourceId);
  const matching = listings.filter(l => matches(l, search));
  const drops = db.priceDrops(search.id, matching, PRICE_DROP_FRACTION);
  const fresh = db.markSeen(search.id, matching);
  if (firstRun) {
    db.markSeeded(search.id, sourceId);
    return { newHits: [], error: null };
  }
  const alerts = [...fresh, ...drops.map(d => ({ ...d.listing, previousPrice: d.previousPrice }))];
  if (!alerts.length) return { newHits: [], error: null };

  // Sold prices are cached for 12h. If a lookup is slow, alert without an estimate; it finishes in the background.
  let prices = [];
  if (search.resaleOverride == null) {
    const lookup = getSoldPrices(search.keywords).catch(() => null);
    prices = await withTimeout(lookup, deps.compsWaitMs ?? COMPS_WAIT_MS, 'comps').catch(() => null);
  }
  const { feePct } = db.getSettings();
  const newHits = [];
  const toAlert = [];
  for (const listing of alerts) {
    const est = prices ? estimate(search, listing, prices, { feePct }) : null;
    const hit = db.addHit(search.id, listing, est);
    newHits.push(hit);
    if (search.minProfit == null || (est && est.profit >= search.minProfit)) toAlert.push(hit);
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
  const nextDue = new Map(); // "searchId:sourceId" -> ms
  const running = new Map(); // "searchId:sourceId" -> promise
  let stopped = false;
  let lastPrune = -Infinity;

  const laneOf = (src) => laneLocks[src.lane] || laneLocks.fetch;

  function runJob(searchId, sourceId) {
    const key = `${searchId}:${sourceId}`;
    if (running.has(key)) return running.get(key);
    const src = sources[sourceId];
    const lock = laneOf(src);
    const p = (async () => {
      await lock.acquire();
      try {
        // Re-read so edits made while this job waited for its lane are respected.
        const s = db.getSearch(searchId);
        if (!s || !s.sources.includes(sourceId)) return { newHits: [], error: null };
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

  function intervalMs(search, src, context) {
    const min = typeof src.minIntervalSec === 'function' ? src.minIntervalSec(context) : (src.minIntervalSec || 0);
    const base = Math.max(search.intervalSec || defaultIntervalSec, min) * 1000;
    return base * (1 + Math.random() * jitter);
  }

  function tick() {
    if (stopped) return;
    try {
      if (now() - lastPrune > PRUNE_EVERY_MS) { lastPrune = now(); db.prune(); }
      const searches = db.listSearches().filter(s => s.enabled);
      const counts = {};
      for (const s of searches) for (const id of s.sources) counts[id] = (counts[id] || 0) + 1;
      for (const s of searches) {
        for (const sourceId of s.sources) {
          const src = sources[sourceId];
          if (!src) continue;
          const key = `${s.id}:${sourceId}`;
          if (running.has(key) || now() < (nextDue.get(key) ?? -Infinity)) continue;
          nextDue.set(key, now() + intervalMs(s, src, { searchCount: counts[sourceId], config: deps.ctx?.config }));
          runJob(s.id, sourceId);
        }
      }
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
      const results = await Promise.all(s.sources.filter(id => sources[id]).map(id => runJob(s.id, id)));
      return {
        newHits: results.flatMap(r => r.newHits),
        errors: results.map(r => r.error).filter(Boolean),
      };
    },
  };
}
