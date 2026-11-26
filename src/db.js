import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL,
  excludeWords TEXT NOT NULL DEFAULT '',
  minPrice REAL, maxPrice REAL,
  zip TEXT NOT NULL DEFAULT '', radius INTEGER NOT NULL DEFAULT 25,
  sources TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  minProfit REAL,
  shipEstimate REAL NOT NULL DEFAULT 4,
  resaleOverride REAL,
  messageTemplate TEXT NOT NULL DEFAULT 'Hi! Is this still available? I can collect today for {offer}.',
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS seen (
  searchId INTEGER NOT NULL, source TEXT NOT NULL, listingId TEXT NOT NULL,
  price REAL, seenAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (searchId, source, listingId)
);
CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  searchId INTEGER NOT NULL,
  listing TEXT NOT NULL, estimate TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS seeded (searchId INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY (searchId, source));
CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL);
`;

// Changing any of these changes which listings match, so the search must re-seed silently.
const MATCH_FIELDS = ['keywords', 'minPrice', 'maxPrice', 'excludeWords'];

const FIELDS = ['name', 'keywords', 'excludeWords', 'minPrice', 'maxPrice', 'zip', 'radius', 'sources', 'enabled', 'minProfit', 'shipEstimate', 'resaleOverride', 'messageTemplate'];
const NULLABLE = ['minPrice', 'maxPrice', 'minProfit', 'resaleOverride'];

// Columns added after the first release; added to older databases on startup.
const MIGRATIONS = [['searches', 'resaleOverride', 'REAL']];

function rowToSearch(r) {
  if (!r) return null;
  return { ...r, sources: JSON.parse(r.sources), enabled: !!r.enabled };
}

function toCol(k, v) {
  if (k === 'sources') return JSON.stringify(v || []);
  if (k === 'enabled') return v ? 1 : 0;
  if (v === undefined || v === '') return NULLABLE.includes(k) ? null : v;
  return v;
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  for (const [table, col, type] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }

  const getSearch = (id) => rowToSearch(db.prepare('SELECT * FROM searches WHERE id = ?').get(id));

  return {
    raw: db,
    getSearch,
    addSearch(s) {
      const keys = FIELDS.filter(k => s[k] !== undefined);
      const r = db.prepare(`INSERT INTO searches (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...keys.map(k => toCol(k, s[k])));
      return getSearch(r.lastInsertRowid);
    },
    listSearches() {
      return db.prepare('SELECT * FROM searches ORDER BY id').all().map(rowToSearch);
    },
    updateSearch(id, patch) {
      const keys = FIELDS.filter(k => patch[k] !== undefined);
      const before = getSearch(id);
      if (before && MATCH_FIELDS.some(k => patch[k] !== undefined && toCol(k, patch[k]) !== toCol(k, before[k]))) {
        db.prepare('DELETE FROM seeded WHERE searchId = ?').run(id);
      }
      if (keys.length) {
        db.prepare(`UPDATE searches SET ${keys.map(k => `${k} = ?`).join(',')} WHERE id = ?`)
          .run(...keys.map(k => toCol(k, patch[k])), id);
      }
      return getSearch(id);
    },
    deleteSearch(id) {
      db.prepare('DELETE FROM seeded WHERE searchId = ?').run(id);
      db.prepare('DELETE FROM searches WHERE id = ?').run(id);
      db.prepare('DELETE FROM seen WHERE searchId = ?').run(id);
      db.prepare('DELETE FROM hits WHERE searchId = ?').run(id);
    },
    hasSeenAny(searchId) {
      return !!db.prepare('SELECT 1 FROM seen WHERE searchId = ? LIMIT 1').get(searchId);
    },
    isSeeded(searchId, source) {
      return !!db.prepare('SELECT 1 FROM seeded WHERE searchId = ? AND source = ?').get(searchId, source);
    },
    markSeeded(searchId, source) {
      db.prepare('INSERT OR IGNORE INTO seeded (searchId, source) VALUES (?, ?)').run(searchId, source);
    },
    markSeen(searchId, listings) {
      const ins = db.prepare('INSERT OR IGNORE INTO seen (searchId, source, listingId, price) VALUES (?, ?, ?, ?)');
      const fresh = [];
      for (const l of listings) {
        const r = ins.run(searchId, l.source, String(l.id), l.price ?? null);
        if (r.changes) fresh.push(l);
      }
      return fresh;
    },
    /**
     * For listings already seen, return those whose price fell by at least minFraction,
     * and remember the new lower price so the same drop doesn't alert twice.
     */
    priceDrops(searchId, listings, minFraction = 0.05) {
      const get = db.prepare('SELECT price FROM seen WHERE searchId = ? AND source = ? AND listingId = ?');
      const upd = db.prepare('UPDATE seen SET price = ? WHERE searchId = ? AND source = ? AND listingId = ?');
      const drops = [];
      for (const l of listings) {
        if (l.price == null) continue;
        const row = get.get(searchId, l.source, String(l.id));
        if (!row || row.price == null || l.price >= row.price) continue;
        upd.run(l.price, searchId, l.source, String(l.id));
        if (row.price - l.price >= row.price * minFraction) drops.push({ listing: l, previousPrice: row.price });
      }
      return drops;
    },
    /** Forget listings seen long ago and old hits the user didn't save, so the database stays small. */
    prune({ seenDays = 45, hitDays = 60 } = {}) {
      db.prepare("DELETE FROM seen WHERE seenAt < datetime('now', ?)").run(`-${seenDays} days`);
      db.prepare("DELETE FROM hits WHERE status != 'saved' AND createdAt < datetime('now', ?)").run(`-${hitDays} days`);
      // Only expire sold-price lookups; other cache rows (e.g. the push keys) must survive.
      db.prepare("DELETE FROM cache WHERE key LIKE 'sold:%' AND at < ?").run(Date.now() - 7 * 24 * 3600 * 1000);
    },
    priceHistory(searchId) {
      return db.prepare('SELECT source, price, seenAt FROM seen WHERE searchId = ? AND price IS NOT NULL ORDER BY seenAt').all(searchId);
    },
    addHit(searchId, listing, estimate = null) {
      const r = db.prepare('INSERT INTO hits (searchId, listing, estimate) VALUES (?, ?, ?)')
        .run(searchId, JSON.stringify(listing), estimate ? JSON.stringify(estimate) : null);
      return { id: Number(r.lastInsertRowid), searchId, listing, estimate, status: 'new' };
    },
    recentHits(limit = 100, { includeDismissed = false } = {}) {
      const where = includeDismissed ? '' : "WHERE h.status != 'dismissed'";
      return db.prepare(`SELECT h.*, s.name AS searchName FROM hits h LEFT JOIN searches s ON s.id = h.searchId ${where} ORDER BY h.id DESC LIMIT ?`)
        .all(limit)
        .map(r => ({ ...r, listing: JSON.parse(r.listing), estimate: r.estimate ? JSON.parse(r.estimate) : null }));
    },
    setHitStatus(id, status) {
      db.prepare('UPDATE hits SET status = ? WHERE id = ?').run(status, id);
    },
    addSubscription(sub) {
      db.prepare('INSERT OR REPLACE INTO subscriptions (endpoint, data) VALUES (?, ?)').run(sub.endpoint, JSON.stringify(sub));
    },
    listSubscriptions() {
      return db.prepare('SELECT data FROM subscriptions').all().map(r => JSON.parse(r.data));
    },
    removeSubscription(endpoint) {
      db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(endpoint);
    },
    getSettings() {
      const rows = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
      return { quietStart: rows.quietStart ?? null, quietEnd: rows.quietEnd ?? null, feePct: Number(rows.feePct ?? 0) };
    },
    setSettings(patch) {
      const st = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const k of ['quietStart', 'quietEnd']) if (k in patch) st.run(k, patch[k] || null);
      if ('feePct' in patch) st.run('feePct', String(Number(patch.feePct) || 0));
      return this.getSettings();
    },
    cacheGet(key, maxAgeMs) {
      const r = db.prepare('SELECT value, at FROM cache WHERE key = ?').get(key);
      return r && Date.now() - r.at < maxAgeMs ? JSON.parse(r.value) : undefined;
    },
    cacheSet(key, value) {
      db.prepare('INSERT OR REPLACE INTO cache (key, value, at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), Date.now());
    },
  };
}
