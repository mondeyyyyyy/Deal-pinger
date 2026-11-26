import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_IDS, SOURCES } from './sources/index.js';
import { median } from './comps.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'dp_session';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HIT_STATUSES = ['new', 'saved', 'dismissed'];

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
  for (const k of ['minPrice', 'maxPrice', 'minProfit', 'shipEstimate', 'radius']) {
    if (body[k] === undefined) continue;
    const v = num(body[k]);
    if (Number.isNaN(v) || (v != null && v < 0)) return err(`${k} must be a positive number`);
    if (k === 'shipEstimate' || k === 'radius') { if (v != null) out[k] = v; } else out[k] = v;
  }
  for (const k of ['zip', 'excludeWords', 'messageTemplate']) if (body[k] !== undefined) out[k] = String(body[k]).trim();
  if (body.enabled !== undefined) out.enabled = !!body.enabled;
  return [out, null];
}

export function createApp({ db, config, runNow, notify, health }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser(config.sessionSecret));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post('/api/login', async (req, res) => {
    const given = Buffer.from(String(req.body?.password || ''));
    const want = Buffer.from(config.appPassword || '');
    const ok = want.length > 0 && given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) {
      await new Promise(r => setTimeout(r, 400));
      return res.status(401).json({ error: 'Wrong password' });
    }
    res.cookie(COOKIE, 'ok', { signed: true, httpOnly: true, sameSite: 'lax', secure: req.secure || req.get('x-forwarded-proto') === 'https', maxAge: 1000 * 3600 * 24 * 365 });
    res.json({ ok: true });
  });

  app.use('/api', (req, res, next) => (req.signedCookies[COOKIE] === 'ok' ? next() : res.status(401).json({ error: 'Login required' })));

  app.post('/api/logout', (_req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });

  app.get('/api/sources', (_req, res) => res.json(SOURCE_IDS.map(id => ({ id, label: SOURCES[id].label }))));

  app.get('/api/searches', (_req, res) => res.json(db.listSearches()));

  app.post('/api/searches', (req, res) => {
    const [s, error] = cleanSearch(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    const created = db.addSearch(s);
    runNow(created.id).catch(() => {});
    res.status(201).json(created);
  });

  const findSearch = (req, res, next) => {
    req.search = db.getSearch(Number(req.params.id));
    return req.search ? next() : res.status(404).json({ error: 'Not found' });
  };

  app.put('/api/searches/:id', findSearch, (req, res) => {
    const [patch, error] = cleanSearch(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    res.json(db.updateSearch(req.search.id, patch));
  });

  app.delete('/api/searches/:id', findSearch, (req, res) => { db.deleteSearch(req.search.id); res.status(204).end(); });

  app.post('/api/searches/:id/run', findSearch, async (req, res) => {
    const r = await runNow(req.search.id);
    res.json({ newHits: r?.newHits?.length ?? 0, errors: r?.errors ?? [] });
  });

  app.get('/api/searches/:id/history', findSearch, (req, res) => {
    const points = db.priceHistory(req.search.id);
    const soldKey = 'sold:' + req.search.keywords.toLowerCase().trim();
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
    db.setHitStatus(Number(req.params.id), status);
    res.json({ ok: true });
  });

  app.get('/api/settings', (_req, res) => res.json(db.getSettings()));
  app.put('/api/settings', (req, res) => {
    const patch = {};
    for (const k of ['quietStart', 'quietEnd']) {
      if (req.body?.[k] === undefined) continue;
      const v = req.body[k] || null;
      if (v && !HHMM.test(v)) return res.status(400).json({ error: `${k} must be HH:MM` });
      patch[k] = v;
    }
    res.json(db.setSettings(patch));
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
