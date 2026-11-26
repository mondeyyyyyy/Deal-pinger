import { matches } from './match.js';
import { estimate } from './comps.js';

const SOURCE_TIMEOUT_MS = 120000;
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

/** Run one search across its sources. Returns new hits (recorded) and per-source errors. */
export async function runSearchOnce(search, { db, sources, notify, ctx, getSoldPrices, health }) {
  const newHits = [];
  const errors = [];
  let soldPromise = null;
  const sold = () => {
    if (!soldPromise) soldPromise = getSoldPrices(search.keywords).catch(() => null);
    return soldPromise;
  };

  for (const sourceId of search.sources) {
    const src = sources[sourceId];
    if (!src) continue;
    let listings;
    try {
      listings = await withTimeout(src.search(search, ctx), SOURCE_TIMEOUT_MS, sourceId);
      health?.record(sourceId, { ok: true, count: listings.length, error: null });
    } catch (e) {
      errors.push({ source: sourceId, message: e.message });
      health?.record(sourceId, { ok: false, error: e.message });
      continue;
    }
    // Seeded = one successful fetch has happened for this source since the search's filters last changed.
    const firstRun = !db.isSeeded(search.id, sourceId);
    const matching = listings.filter(l => matches(l, search));
    const drops = db.priceDrops(search.id, matching, PRICE_DROP_FRACTION);
    const fresh = db.markSeen(search.id, matching);
    if (firstRun) { db.markSeeded(search.id, sourceId); continue; }
    const alerts = [
      ...fresh,
      ...drops.map(d => ({ ...d.listing, previousPrice: d.previousPrice })),
    ];
    const { feePct } = db.getSettings();
    for (const listing of alerts) {
      const prices = search.resaleOverride != null ? [] : await sold();
      const est = prices ? estimate(search, listing, prices, { feePct }) : null;
      const hit = db.addHit(search.id, listing, est);
      newHits.push(hit);
      const worthIt = search.minProfit == null || (est && est.profit >= search.minProfit);
      if (worthIt) await notify(search, hit).catch(() => {});
    }
  }
  return { newHits, errors };
}

/**
 * Poll every enabled search every intervalSec (searches run one after another to keep browser memory low).
 * Returns { stop, runNow(searchId) }.
 */
export function startPoller(deps, { intervalSec = 90, log = console } = {}) {
  let stopped = false;
  let timer = null;
  let running = Promise.resolve();
  // Every run (timer or "Check now") goes through one queue so only one browser session is open at a time.
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };

  const runOne = async (s) => {
    const r = await runSearchOnce(s, deps).catch(e => ({ newHits: [], errors: [{ source: '*', message: e.message }] }));
    if (r.newHits.length) log.info?.(`[${s.name}] ${r.newHits.length} new hit(s)`);
    for (const e of r.errors) log.warn?.(`[${s.name}] ${e.source}: ${e.message}`);
    return r;
  };

  let lastPrune = 0;
  const tick = async () => {
    if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = Date.now();
      deps.db.prune();
    }
    for (const { id } of deps.db.listSearches()) {
      if (stopped) return;
      // Re-read inside the queue so an edit made while waiting is respected.
      await enqueue(() => {
        const s = deps.db.getSearch(id);
        return s?.enabled ? runOne(s) : null;
      });
    }
  };

  const schedule = () => {
    if (stopped) return;
    const jitter = Math.random() * 0.2 * intervalSec * 1000;
    timer = setTimeout(() => { running = safeTick().finally(schedule); }, intervalSec * 1000 + jitter);
  };
  const safeTick = () => tick().catch(e => log.error?.(`poll loop error: ${e.message}`));

  running = safeTick().finally(schedule);

  return {
    stop() { stopped = true; clearTimeout(timer); return running; },
    runNow(searchId) {
      return enqueue(() => {
        const s = deps.db.getSearch(searchId);
        return s ? runOne(s) : null;
      });
    },
  };
}
