import fs from 'node:fs';
import webpush from 'web-push';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './server.js';
import { startPoller, createHealth } from './poller.js';
import { createNotifier, ensureVapid, linkTelegram } from './notify.js';
import { createCompsFetcher } from './comps.js';
import { createFetch } from './net.js';
import { withPage } from './browser.js';
import { SOURCES } from './sources/index.js';

const config = loadConfig();
if (!config.appPassword) {
  console.error('APP_PASSWORD is not set. Set it in your Railway variables.');
  process.exit(1);
}
fs.mkdirSync(config.dataDir, { recursive: true });
const db = openDb(config.dbFile);
ensureVapid(db, config, webpush);
const health = createHealth();
const fetchFn = createFetch(config);
const ctx = { config, fetch: fetchFn, withPage };
const notify = createNotifier({ db, config, webpush, sourceLabel: (id) => SOURCES[id]?.label || id });
const getSoldPrices = createCompsFetcher({ db, fetchFn });

const poller = startPoller(
  { db, sources: SOURCES, notify, ctx, getSoldPrices, health },
  { defaultIntervalSec: config.pollIntervalSec, lanes: { fetch: 4, browser: config.browserConcurrency } },
);

const app = createApp({ db, config, runNow: poller.runNow, notify, health, linkTelegram: (d) => linkTelegram(d) });
const server = app.listen(config.port, () => console.log(`Deal Pinger listening on :${config.port}`));

async function shutdown() {
  server.close();
  await poller.stop();
  const { closeBrowser } = await import('./browser.js');
  await closeBrowser();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
