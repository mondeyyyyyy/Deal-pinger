import { matches } from './match.js';
import { estimate } from './comps.js';

const SOURCE_TIMEOUT_MS = 120000;

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
    const firstRun = !db.hasSeenSource(search.id, sourceId);
    const fresh = db.markSeen(search.id, listings.filter(l => matches(l, search)));
    if (firstRun) continue;
    for (const listing of fresh) {
      const prices = await sold();
      const est = prices ? estimate(search, listing, prices) : null;
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

  const runOne = async (s) => {
    const r = await runSearchOnce(s, deps).catch(e => ({ newHits: [], errors: [{ source: '*', message: e.message }] }));
    if (r.newHits.length) log.info?.(`[${s.name}] ${r.newHits.length} new hit(s)`);
    for (const e of r.errors) log.warn?.(`[${s.name}] ${e.source}: ${e.message}`);
    return r;
  };

  const tick = async () => {
    for (const s of deps.db.listSearches()) {
      if (stopped) return;
      if (s.enabled) await runOne(s);
    }
  };

  const schedule = () => {
    if (stopped) return;
    const jitter = Math.random() * 0.2 * intervalSec * 1000;
    timer = setTimeout(() => { running = tick().finally(schedule); }, intervalSec * 1000 + jitter);
  };

  running = tick().finally(schedule);

  return {
    stop() { stopped = true; clearTimeout(timer); return running; },
    runNow(searchId) {
      const s = deps.db.getSearch(searchId);
      return s ? runOne(s) : Promise.resolve(null);
    },
  };
}
