import { inQuietHours, nowHHMM } from './match.js';

export function formatPush(search, hit, sourceLabel = (s) => s) {
  const l = hit.listing;
  const price = l.price == null ? '?' : `$${l.price}`;
  const parts = [sourceLabel(l.source), search.name];
  if (hit.estimate) {
    const p = hit.estimate.profit;
    parts.push(`${p >= 0 ? '+' : '-'}$${Math.abs(p)} profit (resells ~$${hit.estimate.value})`);
  }
  if (l.location) parts.push(l.location);
  return { title: `${price} · ${l.title}`, body: parts.join(' · '), url: l.url, image: l.image, hitId: hit.id, tag: `${l.source}:${l.id}` };
}

export function createNotifier({ db, config, webpush, now, sourceLabel }) {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  }
  const clock = now || (() => nowHHMM(config.timezone));

  async function sendRaw(payload) {
    if (!config.vapidPublicKey) return 0;
    let sent = 0;
    for (const sub of db.listSubscriptions()) {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high', timeout: 10000 });
        sent++;
      } catch (e) {
        // 404/410: subscription gone; 403: it was made with different VAPID keys.
        if ([403, 404, 410].includes(e.statusCode)) db.removeSubscription(sub.endpoint);
      }
    }
    return sent;
  }

  async function notify(search, hit, { force = false } = {}) {
    if (!force && inQuietHours(db.getSettings(), clock())) return 0;
    return sendRaw(formatPush(search, hit, sourceLabel));
  }
  notify.sendRaw = sendRaw;
  return notify;
}

/** Use VAPID keys from env; otherwise load (or create once) keys stored in the database. Mutates config. */
export function ensureVapid(db, config, webpush) {
  if (config.vapidPublicKey && config.vapidPrivateKey) return config;
  let keys = db.cacheGet('vapid', Infinity);
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    db.cacheSet('vapid', keys);
  }
  config.vapidPublicKey = keys.publicKey;
  config.vapidPrivateKey = keys.privateKey;
  return config;
}
