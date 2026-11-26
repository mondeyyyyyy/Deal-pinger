import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_IDS, SOURCES } from './sources/index.js';
import { median, robustMedian } from './comps.js';
import { mainKeywords } from './match.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'dp_session';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HIT_STATUSES = ['new', 'saved', 'dismissed', 'flagged'];
const SCAM_FILTERS = ['hide', 'flag', 'off'];
const CEX_MODES = ['auto', 'off'];
const TAP_OPENS = ['listing', 'buy'];

const DISCORD_HOOK = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

// Accepts 50, "50", "£50", "1,250.00". Empty → null; anything else → NaN.
const num = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(typeof v === 'string' ? v.replace(/[£,\s]/g, '') : v);
  return Number.isFinite(n) ? n : NaN;
};
const FIELD_ERRORS = {
  minPrice: 'Min price must be a number of pounds',
  maxPrice: 'Max price must be a number of pounds',
  minProfit: 'Minimum profit must be a number of pounds',
  shipEstimate: 'Postage cost must be a number of pounds',
  resaleOverride: 'Resale price must be a number of pounds',
  cexMinProfit: 'CeX minimum profit must be a number of pounds',
  radius: 'Radius must be a number of miles',
  boughtPrice: 'What you paid must be a number of pounds',
  soldPrice: 'Sold price must be a number of pounds',
  fees: 'Fees must be a number of pounds',
};

/** Validate and normalise a search body. Returns [patch, error]. */
function cleanSearch(body, { partial }) {
  const out = {};
  const err = (m) => [null, m];
  if (!partial || body.keywords !== undefined) {
    if (!String(body.keywords || '').trim()) return err('Keywords are required');
    out.keywords = String(body.keywords).trim();
  }
  if (!partial || body.name !== undefined) out.name = String(body.name || body.keywords || '').trim() || out.keywords;
  if (!partial || body.sources !== undefined) {
    if (!Array.isArray(body.sources) || !body.sources.length) return err('Pick at least one marketplace');
    if (body.sources.some(s => !SOURCE_IDS.includes(s))) return err('Unknown marketplace');
    out.sources = [...new Set(body.sources)];
  }
  for (const k of ['minPrice', 'maxPrice', 'minProfit', 'shipEstimate', 'radius', 'resaleOverride', 'cexMinProfit']) {
    if (body[k] === undefined) continue;
    const v = num(body[k]);
    if (Number.isNaN(v) || (v != null && v < 0)) return err(FIELD_ERRORS[k]);
    if (k === 'shipEstimate' || k === 'radius') { if (v != null) out[k] = v; } else out[k] = v;
  }
  if (body.zip !== undefined) out.zip = String(body.zip).trim().toUpperCase(); // UK postcode
  for (const k of ['excludeWords', 'messageTemplate']) if (body[k] !== undefined) out[k] = String(body[k]).trim();
  if (body.enabled !== undefined) out.enabled = !!body.enabled;
  if (body.intervalSec !== undefined) {
    const v = num(body.intervalSec);
    if (v == null || Number.isNaN(v) || v < 15 || v > 3600) return err('Check every must be between 15 seconds and 1 hour');
    out.intervalSec = Math.round(v);
  }
  if (body.cexFilter !== undefined) {
    const v = body.cexFilter || null;
    if (v && !['cash', 'voucher'].includes(v)) return err('CeX filter must be cash or voucher');
    out.cexFilter = v;
  }
  if (body.cexMode !== undefined) {
    if (!CEX_MODES.includes(body.cexMode)) return err('Unknown CeX setting');
    out.cexMode = body.cexMode;
  }
  for (const k of ['cexBoxId', 'cexName']) if (body[k] !== undefined) out[k] = String(body[k] || '').trim().slice(0, 200) || null;
  if (body.discordWebhook !== undefined) {
    const v = String(body.discordWebhook || '').trim();
    if (v && !DISCORD_HOOK.test(v)) return err('That isn\'t a Discord webhook link');
    out.discordWebhook = v || null;
  }
  if ((out.cexFilter ?? body.cexFilter) && (out.cexMode ?? body.cexMode) === 'off') return err("Turn CeX prices on to filter by CeX profit");
  return [out, null];
}

/** A search as the app sees it: its own Discord webhook is never sent back, only whether it's set. */
function publicSearch(s) {
  if (!s) return s;
  const { discordWebhook, ...rest } = s;
  return { ...rest, hasDiscordWebhook: !!discordWebhook };
}

const TG_TOKEN = /^\d+:[\w-]{2,}$/;

/** Settings as the app sees them: channel secrets are never sent back, only whether they're set. */
function publicSettings(s) {
  return {
    quietStart: s.quietStart,
    quietEnd: s.quietEnd,
    feePct: s.feePct,
    discordConnected: !!s.discordWebhook,
    discordMention: s.discordMention,
    scamFilter: s.scamFilter,
    tapOpens: s.tapOpens,
    digestTime: s.digestTime,
    telegramHasToken: !!s.telegramBotToken,
    telegramConnected: !!(s.telegramBotToken && s.telegramChatId),
  };
}

const CSV_HEAD = ['Title', 'Marketplace', 'Bought £', 'Bought on', 'Sold £', 'Sold on', 'Fees £', 'Profit £', 'Notes', 'Link'];
function csvCell(v) {
  if (typeof v === 'number') return String(v); // numbers (including losses) stay numbers
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets treating text as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function createApp({ db, config, runNow, notify, health, linkTelegram, cex }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const smallJson = express.json({ limit: '64kb' });
  // Restores can be large; that route has its own parser.
  app.use((req, res, next) => (req.path === '/api/restore' ? next() : smallJson(req, res, next)));
  app.use(cookieParser(config.sessionSecret));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const failures = new Map(); // ip -> { count, resetAt }
  const MAX_FAILURES = 10;
  const WINDOW_MS = 15 * 60 * 1000;

  app.post('/api/login', async (req, res) => {
    const ip = req.ip;
    if (failures.get(ip)?.resetAt < Date.now()) failures.delete(ip);
    if ((failures.get(ip)?.count || 0) >= MAX_FAILURES) {
      return res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
    }
    const given = Buffer.from(String(req.body?.password || ''));
    const want = Buffer.from(config.appPassword || '');
    const ok = want.length > 0 && given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) {
      const cur = failures.get(ip) || { count: 0, resetAt: Date.now() + WINDOW_MS };
      cur.count++;
      failures.set(ip, cur);
      await new Promise(r => setTimeout(r, 400));
      return res.status(401).json({ error: 'Wrong password' });
    }
    res.cookie(COOKIE, `v${db.getSettings().sessionVersion}`, { signed: true, httpOnly: true, sameSite: 'lax', secure: req.secure || req.get('x-forwarded-proto') === 'https', maxAge: 1000 * 3600 * 24 * 365 });
    res.json({ ok: true });
  });

  // The cookie carries the current session version; "log out all devices" bumps it.
  app.use('/api', (req, res, next) => (req.signedCookies[COOKIE] === `v${db.getSettings().sessionVersion}` ? next() : res.status(401).json({ error: 'Login required' })));

  app.post('/api/logout-all', (_req, res) => {
    db.setSettings({ sessionVersion: String(Number(db.getSettings().sessionVersion) + 1) });
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });

  app.get('/api/sources', (_req, res) => res.json(SOURCE_IDS.map(id => ({ id, label: SOURCES[id].label }))));

  app.get('/api/searches', (_req, res) => {
    const stats = db.searchStats();
    res.json(db.listSearches().map(s => ({ ...publicSearch(s), hitCount: stats[s.id]?.hitCount ?? 0, lastHitAt: stats[s.id]?.lastHitAt ?? null })));
  });

  app.post('/api/searches', (req, res) => {
    const [s, error] = cleanSearch(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    const created = db.addSearch(s);
    runNow(created.id).catch(() => {});
    res.status(201).json(publicSearch(created));
  });

  const findSearch = (req, res, next) => {
    req.search = db.getSearch(Number(req.params.id));
    return req.search ? next() : res.status(404).json({ error: 'Not found' });
  };

  // Pause everything (e.g. on holiday), then resume exactly the searches that were running.
  app.post('/api/searches/pause-all', (_req, res) => {
    const running = db.listSearches().filter(s => s.enabled).map(s => s.id);
    for (const id of running) db.updateSearch(id, { enabled: false });
    if (running.length) db.cacheSet('pausedAll', running);
    res.json({ paused: running.length });
  });
  app.post('/api/searches/resume-all', (_req, res) => {
    const ids = db.cacheGet('pausedAll', Infinity) || [];
    let resumed = 0;
    for (const id of ids) if (db.getSearch(id)) { db.updateSearch(id, { enabled: true }); resumed++; }
    db.cacheSet('pausedAll', []);
    res.json({ resumed });
  });

  app.put('/api/searches/:id', findSearch, (req, res) => {
    const [patch, error] = cleanSearch(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    res.json(publicSearch(db.updateSearch(req.search.id, patch)));
  });

  app.delete('/api/searches/:id', findSearch, (req, res) => { db.deleteSearch(req.search.id); res.status(204).end(); });

  app.post('/api/searches/:id/run', findSearch, async (req, res) => {
    const r = await runNow(req.search.id);
    res.json({ newHits: (r?.newHits ?? []).filter(h => h.status !== 'flagged').length, errors: r?.errors ?? [] });
  });

  app.get('/api/searches/:id/history', findSearch, (req, res) => {
    const points = db.priceHistory(req.search.id);
    const soldKey = 'sold:' + mainKeywords(req.search.keywords).toLowerCase().trim();
    const sold = db.cacheGet(soldKey, Infinity) || [];
    res.json({ points, soldMedian: robustMedian(sold), soldCount: sold.length, askMedian: median(points.map(p => p.price)) });
  });

  app.get('/api/hits', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const status = HIT_STATUSES.includes(req.query.status) ? req.query.status : null;
    const hits = db.recentHits(limit, { status });
    res.json(hits);
  });

  app.put('/api/hits/:id', (req, res) => {
    const status = req.body?.status;
    if (!HIT_STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' });
    const id = Number(req.params.id);
    const before = db.getHit(id);
    // "Not a scam": remember it so a later price drop doesn't hide it again.
    if (before?.status === 'flagged' && status !== 'flagged' && status !== 'dismissed') db.cacheSet(`trust:${before.listing.source}:${before.listing.id}`, 1);
    db.setHitStatus(id, status);
    res.json({ ok: true });
  });

  app.get('/api/settings', (_req, res) => res.json(publicSettings(db.getSettings())));
  app.put('/api/settings', (req, res) => {
    const patch = {};
    for (const k of ['quietStart', 'quietEnd', 'digestTime']) {
      if (req.body?.[k] === undefined) continue;
      const v = req.body[k] || null;
      if (v && !HHMM.test(v)) return res.status(400).json({ error: `${k} must be HH:MM` });
      patch[k] = v;
    }
    if (req.body?.feePct !== undefined) {
      const f = num(req.body.feePct);
      if (f == null || Number.isNaN(f) || f < 0 || f > 50) return res.status(400).json({ error: 'Selling fee must be between 0 and 50%' });
      patch.feePct = f;
    }
    if (req.body?.discordWebhook !== undefined) {
      const v = String(req.body.discordWebhook || '').trim();
      if (v && !DISCORD_HOOK.test(v)) return res.status(400).json({ error: 'That isn\'t a Discord webhook link' });
      patch.discordWebhook = v;
    }
    if (req.body?.tapOpens !== undefined) {
      if (!TAP_OPENS.includes(req.body.tapOpens)) return res.status(400).json({ error: 'Unknown setting' });
      patch.tapOpens = req.body.tapOpens;
    }
    if (req.body?.scamFilter !== undefined) {
      if (!SCAM_FILTERS.includes(req.body.scamFilter)) return res.status(400).json({ error: 'Unknown scam filter setting' });
      patch.scamFilter = req.body.scamFilter;
    }
    if (req.body?.discordMention !== undefined) {
      const v = String(req.body.discordMention || '').trim();
      if (v && !['@everyone', '@here'].includes(v) && !/^\d{5,25}$/.test(v)) return res.status(400).json({ error: 'Mention must be @everyone, @here or a role ID' });
      patch.discordMention = v;
    }
    if (req.body?.telegramBotToken !== undefined) {
      const v = String(req.body.telegramBotToken || '').trim();
      if (v && !TG_TOKEN.test(v)) return res.status(400).json({ error: 'That isn\'t a Telegram bot token' });
      patch.telegramBotToken = v;
      patch.telegramChatId = ''; // a new (or removed) bot needs linking again
    }
    res.json(publicSettings(db.setSettings(patch)));
  });

  app.post('/api/telegram/link', async (_req, res) => {
    try {
      res.json({ chatId: await linkTelegram(db) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/cex/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    try { res.json((await cex.search(q, 8)).slice(0, 8)); } catch (e) { res.status(502).json({ error: `CeX didn't answer: ${e.message}` }); }
  });

  // Backup: searches, settings and flips, without any secrets (bot tokens, webhooks).
  app.get('/api/backup', (_req, res) => {
    const s = db.getSettings();
    const searches = db.listSearches().map(({ id, createdAt, discordWebhook, ...rest }) => rest);
    const flips = db.listFlips().map(({ id, hitId, ...rest }) => rest);
    res.set('content-disposition', `attachment; filename="deal-pinger-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ app: 'deal-pinger', version: 1, exportedAt: new Date().toISOString(),
      settings: { quietStart: s.quietStart, quietEnd: s.quietEnd, feePct: s.feePct, scamFilter: s.scamFilter, tapOpens: s.tapOpens, discordMention: s.discordMention },
      searches, flips, blockedSellers: db.listBlocked().map(({ source, sellerId, name }) => ({ source, sellerId, name })) });
  });

  // Restore adds the backup's searches and flips (it never deletes anything) and applies its settings.
  app.post('/api/restore', express.json({ limit: '5mb' }), (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.searches) || (b.flips != null && !Array.isArray(b.flips))) return res.status(400).json({ error: 'That isn\'t a Deal Pinger backup' });
    // Check everything first, then write it all in one transaction: a bad backup changes nothing.
    const sig = (s) => [String(s.keywords).toLowerCase().trim(), [...s.sources].sort().join(','), s.minPrice ?? '', s.maxPrice ?? '', String(s.excludeWords || '').toLowerCase().trim()].join('|');
    const have = new Set(db.listSearches().map(sig));
    const cleaned = [];
    let skipped = 0;
    for (const raw of b.searches) {
      const [s, error] = cleanSearch({ ...raw, discordWebhook: undefined }, { partial: false });
      if (error) return res.status(400).json({ error: `Search "${raw?.name ?? '?'}": ${error}` });
      // Already watching the same thing: adding it again would double every alert.
      if (have.has(sig(s))) { skipped++; continue; }
      have.add(sig(s));
      cleaned.push(s);
    }
    const flipSig = (f) => `${String(f.title).toLowerCase()}|${f.boughtPrice}|${String(f.boughtAt || '').slice(0, 10)}`;
    const haveFlips = new Set(db.listFlips().map(flipSig));
    const flipRows = [];
    for (const f of b.flips || []) {
      const row = { title: String(f?.title ?? '').trim(), boughtPrice: num(f?.boughtPrice), soldPrice: num(f?.soldPrice), fees: num(f?.fees) ?? 0 };
      if (!row.title) return res.status(400).json({ error: 'A flip in the backup has no name' });
      for (const k of ['boughtPrice', 'soldPrice', 'fees']) {
        if (Number.isNaN(row[k]) || (row[k] != null && row[k] < 0)) return res.status(400).json({ error: `Flip "${row.title}": ${FIELD_ERRORS[k]}` });
      }
      if (row.boughtPrice == null) return res.status(400).json({ error: `Flip "${row.title}": ${FIELD_ERRORS.boughtPrice}` });
      flipRows.push({ ...row, source: f.source ?? null, url: f.url ?? null, image: f.image ?? null, notes: String(f.notes ?? ''),
        boughtAt: typeof f.boughtAt === 'string' ? f.boughtAt : undefined,
        soldAt: row.soldPrice != null && typeof f.soldAt === 'string' ? f.soldAt : null });
      // Restoring the same backup twice mustn't double your flips (or your profit figures).
      const fs = flipSig(flipRows.at(-1));
      if (f.boughtAt && haveFlips.has(fs)) flipRows.pop(); else haveFlips.add(fs);
    }
    db.raw.exec('BEGIN');
    try {
      for (const s of cleaned) db.addSearch(s);
      for (const f of flipRows) db.addFlip(f);
      const key = (x) => `${x.source}|${x.sellerId ?? ''}|${String(x.name ?? '').toLowerCase()}`;
      const haveBlocked = new Set(db.listBlocked().map(key));
      for (const x of Array.isArray(b.blockedSellers) ? b.blockedSellers : []) {
        if (!SOURCE_IDS.includes(x?.source) || (!x.sellerId && !x.name) || haveBlocked.has(key(x))) continue;
        db.blockSeller({ source: x.source, sellerId: x.sellerId ?? null, name: x.name ?? null });
        haveBlocked.add(key(x));
      }
      db.raw.exec('COMMIT');
    } catch (e) {
      db.raw.exec('ROLLBACK');
      return res.status(400).json({ error: `Couldn't restore: ${e.message}` });
    }
    const flips = flipRows.length;
    const st = b.settings || {};
    const patch = {};
    if (HHMM.test(st.quietStart || '') || st.quietStart === null) patch.quietStart = st.quietStart;
    if (HHMM.test(st.quietEnd || '') || st.quietEnd === null) patch.quietEnd = st.quietEnd;
    if (num(st.feePct) >= 0 && num(st.feePct) <= 50) patch.feePct = num(st.feePct);
    if (SCAM_FILTERS.includes(st.scamFilter)) patch.scamFilter = st.scamFilter;
    if (TAP_OPENS.includes(st.tapOpens)) patch.tapOpens = st.tapOpens;
    db.setSettings(patch);
    res.json({ searches: cleaned.length, skipped, flips });
  });

  // Blocked sellers: their listings never show up again.
  app.get('/api/blocked', (_req, res) => res.json(db.listBlocked()));
  app.post('/api/blocked', (req, res) => {
    const hit = req.body?.hitId != null ? db.getHit(Number(req.body.hitId)) : null;
    if (!hit) return res.status(404).json({ error: 'Deal not found' });
    const l = hit.listing;
    const sellerId = l.sellerId ?? null;
    const name = l.sellerName || l.seller?.name || null;
    if (!sellerId && !name) return res.status(400).json({ error: "This marketplace doesn't show who the seller is" });
    db.blockSeller({ source: l.source, sellerId, name });
    // Hide their other deals too.
    const r = db.raw.prepare(`UPDATE hits SET status = 'dismissed' WHERE status IN ('new', 'flagged') AND json_extract(listing, '$.source') = ?
      AND ((? IS NOT NULL AND json_extract(listing, '$.sellerId') = ?)
        OR (? IS NOT NULL AND (lower(json_extract(listing, '$.sellerName')) = lower(?) OR lower(json_extract(listing, '$.seller.name')) = lower(?))))`)
      .run(l.source, sellerId, sellerId != null ? String(sellerId) : null, name, name, name);
    res.json({ blocked: name || sellerId, hidden: Number(r.changes) });
  });
  app.delete('/api/blocked/:id', (req, res) => { db.unblock(Number(req.params.id)); res.status(204).end(); });

  // Insights: profit per month (last 6), where deals and flips come from, best flips.
  app.get('/api/insights', (_req, res) => {
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    const flips = db.listFlips();
    const profitOf = (f) => Math.round((f.soldPrice - f.boughtPrice - f.fees) * 100) / 100;
    const sold = flips.filter(f => f.soldPrice != null && f.soldAt);
    const monthly = months.map(m => {
      const inMonth = sold.filter(f => f.soldAt.slice(0, 7) === m);
      return { month: m, profit: Math.round(inMonth.reduce((a, f) => a + profitOf(f), 0) * 100) / 100, sold: inMonth.length };
    });
    const dealRows = db.raw.prepare(`SELECT json_extract(listing, '$.source') AS source, COUNT(*) AS n FROM hits
      WHERE status NOT IN ('flagged') AND createdAt >= datetime('now', '-30 days') GROUP BY source`).all();
    const sources = SOURCE_IDS.map(id => ({
      source: id, label: SOURCES[id].label,
      deals: dealRows.find(r => r.source === id)?.n ?? 0,
      bought: flips.filter(f => f.source === id).length,
      profit: Math.round(sold.filter(f => f.source === id).reduce((a, f) => a + profitOf(f), 0) * 100) / 100,
    }));
    const bestFlips = sold.map(f => ({ id: f.id, title: f.title, profit: profitOf(f), source: f.source })).sort((a, b) => b.profit - a.profit).slice(0, 5);
    res.json({ months: monthly, sources, bestFlips });
  });

  app.get('/api/flips', (_req, res) => res.json({ flips: db.listFlips(), summary: db.flipSummary() }));

  app.post('/api/flips', (req, res) => {
    const b = req.body || {};
    const hit = b.hitId != null ? db.getHit(Number(b.hitId)) : null;
    const title = String(b.title ?? hit?.listing.title ?? '').trim();
    const bought = num(b.boughtPrice ?? hit?.listing.price);
    if (!title) return res.status(400).json({ error: 'Give it a name' });
    if (bought == null || Number.isNaN(bought) || bought < 0) return res.status(400).json({ error: 'Enter what you paid' });
    const flip = db.addFlip({
      hitId: hit?.id ?? null, title, boughtPrice: bought,
      source: b.source ?? hit?.listing.source ?? null, url: b.url ?? hit?.listing.url ?? null, image: hit?.listing.image ?? null,
    });
    if (hit) db.setHitStatus(hit.id, 'saved');
    res.status(201).json(flip);
  });

  app.put('/api/flips/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.getFlip(id)) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const patch = {};
    for (const k of ['boughtPrice', 'soldPrice', 'fees']) {
      if (b[k] === undefined) continue;
      const v = num(b[k]);
      if (Number.isNaN(v) || (v != null && v < 0)) return res.status(400).json({ error: FIELD_ERRORS[k] });
      if (k === 'boughtPrice' && v == null) return res.status(400).json({ error: 'Enter what you paid' });
      patch[k] = k === 'fees' ? (v ?? 0) : v;
    }
    for (const k of ['title', 'notes']) if (b[k] !== undefined) patch[k] = String(b[k]).trim();
    res.json(db.updateFlip(id, patch));
  });

  app.delete('/api/flips/:id', (req, res) => { db.deleteFlip(Number(req.params.id)); res.status(204).end(); });

  app.get('/api/flips.csv', (_req, res) => {
    const label = (id) => SOURCES[id]?.label || id || '';
    const rows = db.listFlips().map(f => [
      f.title, label(f.source), f.boughtPrice, f.boughtAt?.slice(0, 10), f.soldPrice, f.soldAt?.slice(0, 10), f.fees,
      f.soldPrice != null ? Math.round((f.soldPrice - f.boughtPrice - f.fees) * 100) / 100 : '', f.notes, f.url,
    ]);
    res.set('content-type', 'text/csv; charset=utf-8');
    res.set('content-disposition', 'attachment; filename="deal-pinger-flips.csv"');
    res.send([CSV_HEAD, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n');
  });

  app.get('/api/vapid', (_req, res) => res.json({ publicKey: config.vapidPublicKey || null }));

  app.post('/api/subscribe', (req, res) => {
    const sub = req.body;
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys) return res.status(400).json({ error: 'Bad subscription' });
    db.addSubscription({ endpoint: sub.endpoint, keys: sub.keys });
    res.status(201).json({ ok: true });
  });

  app.post('/api/test-push', async (_req, res) => {
    const sent = await notify.sendRaw({ title: 'Deal Pinger is working', body: 'You will get alerts like this when a new deal shows up.', url: '/' });
    res.json({ sent });
  });

  app.get('/api/status', (_req, res) => res.json({
    sources: SOURCE_IDS.map(id => ({ id, label: SOURCES[id].label, ...(health.get()[id] || {}) })),
    pushConfigured: !!config.vapidPublicKey,
    ebayApi: !!(config.ebayAppId && config.ebayCertId),
    subscriptions: db.listSubscriptions().length,
    pollIntervalSec: config.pollIntervalSec,
  }));

  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  return app;
}
