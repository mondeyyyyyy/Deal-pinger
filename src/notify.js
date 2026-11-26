import { inQuietHours, nowHHMM } from './match.js';
import { buildMessage } from '../public/messages.js';

const HOT_SCORE = 50; // best profit at least half the asking price
const SUMMARY_OVER = 3; // more alertable hits than this from one check → one summary alert
const money = (n) => `£${Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2)}`;
const signed = (n) => `${n >= 0 ? '+' : '-'}${money(Math.abs(n))}`;
const best = (h) => h.estimate?.bestProfit ?? h.estimate?.profit ?? null;

function risky(l) { return l.scam && l.scam.risk !== 'low'; }

function lead(hit) {
  const l = hit.listing;
  const price = l.price == null ? '?' : money(l.price);
  const mark = risky(l) ? '⚠️ ' : hit.estimate && hit.estimate.score >= HOT_SCORE ? '🔥 ' : '';
  return mark + (l.previousPrice != null ? `Price drop ${money(l.previousPrice)} → ${price}` : price);
}

function valueParts(e) {
  const parts = [];
  if (e?.profit != null && e?.value != null) parts.push(`${signed(e.profit)} profit (resells ~${money(e.value)})`);
  if (e?.cex) parts.push(`CeX cash ${money(e.cex.cash)} (${signed(e.cex.cashProfit)})`);
  return parts;
}

export function formatPush(search, hit, sourceLabel = (s) => s, { tapOpens = 'listing' } = {}) {
  const l = hit.listing;
  const parts = [sourceLabel(l.source), search.name, ...valueParts(hit.estimate)];
  if (l.location) parts.push(l.location);
  if (risky(l)) parts.push(`⚠️ ${l.scam.reasons.join(', ')}`);
  return { title: `${lead(hit)} · ${l.title}`, body: parts.join(' · '), url: tapOpens === 'buy' && l.buyUrl && !risky(l) ? l.buyUrl : l.url, image: l.image, hitId: hit.id, tag: `${l.source}:${l.id}` };
}

/** One alert for a burst of hits, best profit first. */
export function formatSummary(search, hits, sourceLabel = (s) => s) {
  const ranked = [...hits].sort((a, b) => (best(b) ?? -Infinity) - (best(a) ?? -Infinity));
  const line = (h) => `${h.listing.price == null ? '?' : money(h.listing.price)} ${h.listing.title}`;
  return {
    title: `${hits.length} new deals · ${search.name}`,
    body: ranked.slice(0, 3).map(line).join(' · '),
    url: '/',
    tag: `summary:${search.id ?? search.name}:${Date.now()}:${hits[0]?.listing?.id ?? ''}`,
    items: ranked.map(h => ({ title: line(h), url: h.listing.url, source: sourceLabel(h.listing.source), profit: best(h) })),
  };
}

/* ---------- Discord ---------- */

// Discord markdown link text can't contain [ ] or a closing ) without breaking the link.
const linkText = (s) => String(s).replace(/[[\]]/g, '').replace(/\)/g, '').slice(0, 120);
const COLORS = { high: 0xd93a3a, medium: 0xf0a020, hot: 0xff5a1f, normal: 0x5865f2 };

/** "@everyone", "@here", or a role id → message content + allowed_mentions (nothing else ever pings). */
function mentionFor(m) {
  const v = String(m || '').trim();
  if (v === '@everyone' || v === '@here') return { content: v, allowed_mentions: { parse: ['everyone'] } };
  if (/^\d{5,25}$/.test(v)) return { content: `<@&${v}>`, allowed_mentions: { roles: [v] } };
  return { allowed_mentions: { parse: [] } };
}

function discordDeal(search, hit, sourceLabel) {
  const l = hit.listing;
  const e = hit.estimate;
  const links = [];
  if (l.buyUrl && l.scam?.risk !== 'high') links.push(`[Buy now](${l.buyUrl})`);
  links.push(`[Open listing](${l.url})`);
  if (e?.cex?.url) links.push(`[CeX](${e.cex.url})`);
  const fields = [{ name: 'Price', value: l.price == null ? '?' : money(l.price), inline: true }];
  if (e?.value != null && e?.profit != null) fields.push({ name: 'eBay resale', value: `${money(e.value)} · ${signed(e.profit)}`, inline: true });
  if (e?.cex) fields.push({ name: 'CeX', value: `sells ${money(e.cex.sell)} · cash ${money(e.cex.cash)} (${signed(e.cex.cashProfit)})${e.cex.voucher != null ? ` · voucher ${money(e.cex.voucher)}` : ''}`, inline: false });
  if (l.seller) fields.push({ name: 'Seller', value: [l.seller.name, l.seller.ratings != null ? `${l.seller.ratings} ratings` : null].filter(Boolean).join(' · ') || 'unknown', inline: true });
  fields.push({ name: 'Marketplace', value: sourceLabel(l.source), inline: true });
  fields.push({ name: 'Search', value: String(search.name).slice(0, 100), inline: true });
  if (risky(l)) fields.push({ name: '⚠️ Scam check', value: l.scam.reasons.join(', ').slice(0, 1000) || 'looks risky', inline: false });
  const color = l.scam?.risk === 'high' ? COLORS.high : l.scam?.risk === 'medium' ? COLORS.medium : e && e.score >= HOT_SCORE ? COLORS.hot : COLORS.normal;
  const embed = { title: `${lead(hit)} · ${l.title}`.slice(0, 256), url: l.url, description: links.join(' · '), color, fields, timestamp: new Date().toISOString(), footer: { text: 'Deal Pinger' } };
  if (l.image?.startsWith('http')) embed.image = { url: l.image };
  return embed;
}

function discordSummary(p) {
  // Embed descriptions allow 4,096 characters; stop adding lines before that.
  let desc = '';
  for (const i of p.items.slice(0, 15)) {
    const line = `• [${linkText(i.title)}](${i.url}) · ${i.source}${i.profit != null ? ` · ${signed(i.profit)}` : ''}\n`;
    if (desc.length + line.length > 4000) break;
    desc += line;
  }
  return { title: p.title.slice(0, 256), description: desc.trim(), color: COLORS.normal };
}

/* ---------- Telegram ---------- */

const html = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function telegramDeal(search, hit, sourceLabel) {
  const l = hit.listing;
  const lines = [`<b>${html(`${lead(hit)} · ${l.title}`)}</b>`, html([sourceLabel(l.source), search.name, ...valueParts(hit.estimate)].join(' · '))];
  if (l.seller) lines.push(html(`Seller: ${[l.seller.name, l.seller.ratings != null ? `${l.seller.ratings} ratings` : null].filter(Boolean).join(' · ')}`));
  if (risky(l)) lines.push(html(`⚠️ Scam check: ${l.scam.reasons.join(', ')}`));
  lines.push('', 'Message to send:', `<code>${html(buildMessage(search.messageTemplate, l))}</code>`);
  const row1 = [];
  if (l.buyUrl && l.scam?.risk !== 'high') row1.push({ text: '🛒 Buy now', url: l.buyUrl });
  row1.push({ text: '🔗 Open listing', url: l.url });
  const keyboard = [row1];
  if (hit.estimate?.cex?.url) keyboard.push([{ text: '💷 CeX', url: hit.estimate.cex.url }]);
  return { text: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
}

function telegramSummary(p) {
  const items = p.items.slice(0, 15).map(i => `• <a href="${html(i.url)}">${html(i.title)}</a> (${html(i.source)})${i.profit != null ? ' ' + html(signed(i.profit)) : ''}`);
  return { text: `<b>${html(p.title)}</b>\n\n${items.join('\n')}`, parse_mode: 'HTML', disable_web_page_preview: true };
}

function telegramPlain(p) {
  return { text: [p.title, p.body, p.url?.startsWith('http') ? p.url : null].filter(Boolean).join('\n') };
}

/* ---------- sending ---------- */

export function createNotifier({ db, config, webpush, now, sourceLabel = (s) => s, fetchFn = fetch, log = console }) {
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

  function checked(r, name) {
    if (r.ok) return 1;
    log.warn?.(`${name} alert failed: HTTP ${r.status}`);
    return 0;
  }

  async function sendPush(full) {
    if (!config.vapidPublicKey) return 0;
    // Apple rejects push payloads over 4KB: send only what the phone shows.
    const payload = { title: String(full.title || '').slice(0, 150), body: String(full.body || '').slice(0, 300), url: full.url, tag: full.tag, hitId: full.hitId };
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

  /**
   * Send one alert to every configured channel at once.
   * msg = { push, discordEmbed?, telegram? }; search may carry its own Discord channel.
   */
  async function sendAll(msg, search = null) {
    const s = db.getSettings();
    const jobs = [sendPush(msg.push)];
    const hook = search?.discordWebhook || s.discordWebhook;
    if (hook) {
      const embed = msg.discordEmbed || { title: msg.push.title.slice(0, 256), description: msg.push.body, color: COLORS.normal };
      jobs.push(post(hook, { ...mentionFor(s.discordMention), embeds: [embed] }).then(r => checked(r, 'Discord')));
    }
    if (s.telegramBotToken && s.telegramChatId) {
      const tg = msg.telegram || telegramPlain(msg.push);
      jobs.push(post(`https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`, { chat_id: s.telegramChatId, ...tg }).then(r => checked(r, 'Telegram')));
    }
    const results = await Promise.allSettled(jobs);
    return results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value : 0), 0);
  }

  const quiet = () => inQuietHours(db.getSettings(), clock());

  const dealMsg = (search, hit) => ({
    push: formatPush(search, hit, sourceLabel, { tapOpens: db.getSettings().tapOpens }),
    discordEmbed: discordDeal(search, hit, sourceLabel),
    telegram: telegramDeal(search, hit, sourceLabel),
  });

  // Deals held back by quiet hours are counted, so you hear about them once quiet hours end.
  function holdForQuiet(n) {
    db.setSettings({ quietMissed: String(Number(db.getSettings().quietMissed || 0) + n) });
    return 0;
  }

  async function notify(search, hit, { force = false } = {}) {
    if (!force && quiet()) return holdForQuiet(1);
    return sendAll(dealMsg(search, hit), search);
  }
  /** Service messages (outage warnings, the daily summary): skipped during quiet hours. */
  notify.isQuiet = quiet;
  notify.info = (payload) => (quiet() ? Promise.resolve(0) : sendAll({ push: payload }));
  /** Call regularly: once quiet hours are over, say how many deals arrived during them. */
  notify.afterQuiet = async () => {
    const missed = Number(db.getSettings().quietMissed || 0);
    if (!missed || quiet()) return 0;
    db.setSettings({ quietMissed: '0' });
    return sendAll({ push: { title: `${missed} deal${missed === 1 ? '' : 's'} came in during quiet hours`, body: 'Open Deal Pinger to see them.', url: '/', tag: 'quiet-summary' } });
  };
  notify.batch = async (search, hits) => {
    if (!hits.length) return 0;
    if (quiet()) return holdForQuiet(hits.length);
    if (hits.length > SUMMARY_OVER) {
      const p = formatSummary(search, hits, sourceLabel);
      return sendAll({ push: p, discordEmbed: discordSummary(p), telegram: telegramSummary(p) }, search);
    }
    let n = 0;
    for (const h of hits) n += await sendAll(dealMsg(search, h), search);
    return n;
  };
  /** Plain message (e.g. the test alert) to every channel. */
  notify.sendRaw = (payload) => sendAll({ push: payload });
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
