import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_IDS, SOURCES } from './sources/index.js';
import { median } from './comps.js';
import { mainKeywords } from './match.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'dp_session';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HIT_STATUSES = ['new', 'saved', 'dismissed', 'flagged'];
const SCAM_FILTERS = ['hide', 'flag', 'off'];
const CEX_MODES = ['auto', 'off'];
const TAP_OPENS = ['listing', 'buy'];

const DISCORD_HOOK = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

const num = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

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
  for (const k of ['minPrice', 'maxPrice', 'minProfit', 'shipEstimate', 'radius', 'resaleOverride']) {
    if (body[k] === undefined) continue;
    const v = num(body[k]);
    if (Number.isNaN(v) || (v != null && v < 0)) return err(`${k} must be a positive number`);
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
    res.json({ points, soldMedian: median(sold), soldCount: sold.length, askMedian: median(points.map(p => p.price)) });
  });

  app.get('/api/hits', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    let hits = db.recentHits(limit);
    if (req.query.status) hits = hits.filter(h => h.status === req.query.status);
    res.json(hits);
  });

  app.put('/api/hits/:id', (req, res) => {
    const status = req.body?.status;
    if (!HIT_STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' });
    const id = Number(req.params.id);
    const before = db.recentHits(1000, { includeDismissed: true }).find(h => h.id === id);
    // "Not a scam": remember it so a later price drop doesn't hide it again.
    if (before?.status === 'flagged' && status !== 'flagged' && status !== 'dismissed') db.cacheSet(`trust:${before.listing.source}:${before.listing.id}`, 1);
    db.setHitStatus(id, status);
    res.json({ ok: true });
  });

  app.get('/api/settings', (_req, res) => res.json(publicSettings(db.getSettings())));
  app.put('/api/settings', (req, res) => {
    const patch = {};
    for (const k of ['quietStart', 'quietEnd']) {
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
      searches, flips });
  });

  // Restore adds the backup's searches and flips (it never deletes anything) and applies its settings.
  app.post('/api/restore', express.json({ limit: '5mb' }), (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.searches) || (b.flips != null && !Array.isArray(b.flips))) return res.status(400).json({ error: 'That isn\'t a Deal Pinger backup' });
    const cleaned = [];
    for (const raw of b.searches) {
      const [s, error] = cleanSearch({ ...raw, discordWebhook: undefined }, { partial: false });
      if (error) return res.status(400).json({ error: `Search "${raw?.name ?? '?'}": ${error}` });
      cleaned.push(s);
    }
    for (const s of cleaned) db.addSearch(s);
    let flips = 0;
    for (const f of b.flips || []) {
      const bought = num(f.boughtPrice);
      if (!f.title || bought == null || Number.isNaN(bought)) continue;
      db.addFlip({ title: String(f.title), boughtPrice: bought, source: f.source ?? null, url: f.url ?? null, image: f.image ?? null,
        soldPrice: num(f.soldPrice) ?? null, soldAt: f.soldAt ?? null, fees: num(f.fees) ?? 0, notes: String(f.notes ?? '') });
      flips++;
    }
    const st = b.settings || {};
    const patch = {};
    if (HHMM.test(st.quietStart || '') || st.quietStart === null) patch.quietStart = st.quietStart;
    if (HHMM.test(st.quietEnd || '') || st.quietEnd === null) patch.quietEnd = st.quietEnd;
    if (num(st.feePct) >= 0 && num(st.feePct) <= 50) patch.feePct = num(st.feePct);
    if (SCAM_FILTERS.includes(st.scamFilter)) patch.scamFilter = st.scamFilter;
    if (TAP_OPENS.includes(st.tapOpens)) patch.tapOpens = st.tapOpens;
    db.setSettings(patch);
    res.json({ searches: cleaned.length, flips });
  });

  app.get('/api/flips', (_req, res) => res.json({ flips: db.listFlips(), summary: db.flipSummary() }));

  app.post('/api/flips', (req, res) => {
    const b = req.body || {};
    const hit = b.hitId != null ? db.recentHits(1000, { includeDismissed: true }).find(h => h.id === Number(b.hitId)) : null;
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
      if (Number.isNaN(v) || (v != null && v < 0)) return res.status(400).json({ error: `${k} must be a positive number` });
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
