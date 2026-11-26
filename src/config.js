import path from 'node:path';

export function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR || './data';
  return {
    port: Number(env.PORT || 3000),
    dataDir,
    dbFile: path.join(dataDir, 'deal-pinger.db'),
    appPassword: env.APP_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || env.APP_PASSWORD || 'dev-secret',
    vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || '',
    vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
    ebayAppId: env.EBAY_APP_ID || '',
    ebayCertId: env.EBAY_CERT_ID || '',
    craigslistSite: env.CRAIGSLIST_SITE || 'sfbay',
    proxyUrl: env.PROXY_URL || '',
    pollIntervalSec: Number(env.POLL_INTERVAL_SEC || 90),
    timezone: env.TZ || 'America/Los_Angeles',
  };
}
