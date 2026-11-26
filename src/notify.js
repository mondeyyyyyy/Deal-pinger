import { inQuietHours, nowHHMM } from './match.js';

const HOT_SCORE = 50; // profit at least half the asking price
const SUMMARY_OVER = 3; // more alertable hits than this from one check → one summary alert
const money = (n) => `£${Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2)}`;

export function formatPush(search, hit, sourceLabel = (s) => s) {
  const l = hit.listing;
  const price = l.price == null ? '?' : money(l.price);
  const hot = hit.estimate && hit.estimate.score >= HOT_SCORE ? '🔥 ' : '';
  const lead = l.previousPrice != null ? `Price drop ${money(l.previousPrice)} → ${price}` : price;
  const parts = [sourceLabel(l.source), search.name];
  if (hit.estimate) {
    const p = hit.estimate.profit;
    parts.push(`${p >= 0 ? '+' : '-'}£${Math.abs(p)} profit (resells ~£${hit.estimate.value})`);
  }
  if (l.location) parts.push(l.location);
  return { title: `${hot}${lead} · ${l.title}`, body: parts.join(' · '), url: l.url, image: l.image, hitId: hit.id, tag: `${l.source}:${l.id}` };
}

/** One alert for a burst of hits, best profit first. */
export function formatSummary(search, hits, sourceLabel = (s) => s) {
  const ranked = [...hits].sort((a, b) => (b.estimate?.profit ?? -Infinity) - (a.estimate?.profit ?? -Infinity));
  const line = (h) => `${h.listing.price == null ? '?' : money(h.listing.price)} ${h.listing.title}`;
  return {
    title: `${hits.length} new deals · ${search.name}`,
    body: ranked.slice(0, 3).map(line).join(' · '),
    url: '/',
    tag: `summary:${search.id ?? search.name}:${Date.now()}:${hits[0]?.listing?.id ?? ''}`,
    items: ranked.map(h => ({ title: line(h), url: h.listing.url, source: sourceLabel(h.listing.source) })),
  };
}

// Discord markdown link text can't contain [ ] or a closing ) without breaking the link.
const linkText = (s) => String(s).replace(/[[\]]/g, '').replace(/\)/g, '').slice(0, 120);

function discordBody(p) {
  if (p.items) {
    // Embed descriptions allow 4,096 characters; stop adding lines before that.
    let desc = '';
    for (const i of p.items.slice(0, 15)) {
      const line = `• [${linkText(i.title)}](${i.url}) · ${i.source}\n`;
      if (desc.length + line.length > 4000) break;
      desc += line;
    }
    return { embeds: [{ title: p.title.slice(0, 256), description: desc.trim() }] };
  }
  const embed = { title: p.title.slice(0, 256), description: p.body, url: p.url?.startsWith('http') ? p.url : undefined };
  if (p.image?.startsWith('http')) embed.thumbnail = { url: p.image };
  return { embeds: [embed] };
}

function telegramText(p) {
  if (p.items) return `${p.title}\n\n` + p.items.slice(0, 10).map(i => `• ${i.title} (${i.source})\n${i.url}`).join('\n');
  return [p.title, p.body, p.url?.startsWith('http') ? p.url : null].filter(Boolean).join('\n');
}

export function createNotifier({ db, config, webpush, now, sourceLabel, fetchFn = fetch, log = console }) {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  }
  const clock = now || (() => nowHHMM(config.timezone));
  const post = (url, body) => fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  async function sendPush(payload) {
    if (!config.vapidPublicKey) return 0;
    const results = await Promise.all(db.listSubscriptions().map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high', timeout: 10000 });
        return 1;
      } catch (e) {
        // 404/410: subscription gone; 403: it was made with different VAPID keys.
        if ([403, 404, 410].includes(e.statusCode)) db.removeSubscription(sub.endpoint);
        return 0;
      }
    }));
    return results.reduce((a, b) => a + b, 0);
  }

  /** Send to every configured channel at once. Returns how many deliveries succeeded. */
  async function sendRaw(payload) {
    const s = db.getSettings();
    const jobs = [sendPush(payload)];
    if (s.discordWebhook) jobs.push(post(s.discordWebhook, discordBody(payload)).then(r => checked(r, 'Discord')));
    if (s.telegramBotToken && s.telegramChatId) {
      jobs.push(post(`https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`, {
        chat_id: s.telegramChatId, text: telegramText(payload), disable_web_page_preview: false,
      }).then(r => checked(r, 'Telegram')));
    }
    const results = await Promise.allSettled(jobs);
    return results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value : 0), 0);
  }

  function checked(r, name) {
    if (r.ok) return 1;
    log.warn?.(`${name} alert failed: HTTP ${r.status}`);
    return 0;
  }

  const quiet = () => inQuietHours(db.getSettings(), clock());

  async function notify(search, hit, { force = false } = {}) {
    if (!force && quiet()) return 0;
    return sendRaw(formatPush(search, hit, sourceLabel));
  }
  notify.batch = async (search, hits) => {
    if (!hits.length || quiet()) return 0;
    if (hits.length > SUMMARY_OVER) return sendRaw(formatSummary(search, hits, sourceLabel));
    let n = 0;
    for (const h of hits) n += await sendRaw(formatPush(search, h, sourceLabel));
    return n;
  };
  notify.sendRaw = sendRaw;
  return notify;
}

/** After the user sends /start to their bot, find that chat and save it. Returns the chat id. */
export async function linkTelegram(db, fetchFn = fetch) {
  const { telegramBotToken } = db.getSettings();
  if (!telegramBotToken) throw new Error('Add your Telegram bot token first');
  const res = await fetchFn(`https://api.telegram.org/bot${telegramBotToken}/getUpdates`, { signal: AbortSignal.timeout(10000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error('Telegram rejected the bot token');
  // Only trust a private chat that sent /start: the bot's name is public, so anyone could message it.
  const starts = (j.result || []).map(u => u.message).filter(m => m?.chat?.type === 'private' && /^\/start\b/.test(m.text || ''));
  if (!starts.length) throw new Error('Send /start to your bot in Telegram, then try again');
  const chatId = String(starts.at(-1).chat.id);
  db.setSettings({ telegramChatId: chatId });
  return chatId;
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
