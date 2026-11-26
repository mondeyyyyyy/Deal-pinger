import { buildMessage, DEFAULT_TEMPLATE } from './messages.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
const money = (v) => {
  const n = v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? '£' + (Number.isInteger(n) ? n : n.toFixed(2)) : '—';
};

let SOURCES = [];
let searches = [];
let hits = [];
let dealFilter = 'all';
let tab = 'deals';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Login required'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(msg) {
  // One toast at a time: a new message replaces the old one.
  let t = $('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.append(t);
  }
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

function ago(iso) {
  const t = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

const srcLabel = (id) => SOURCES.find((s) => s.id === id)?.label || id;

/* ---------- auth ---------- */
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#pw').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
    $('#pw').value = '';
    start();
  } catch (err) { $('#loginErr').textContent = err.message; }
});

/* ---------- tabs ---------- */
const TITLES = { deals: 'Deals', searches: 'Searches', flips: 'Flips', settings: 'Settings' };
const REFRESH_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';
const PLUS_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

function setTab(t) {
  tab = t;
  $$('nav.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  for (const k of Object.keys(TITLES)) $('#tab-' + k).classList.toggle('hidden', k !== t);
  $('#title').textContent = TITLES[t];
  const hb = $('#headerAction');
  hb.classList.toggle('hidden', t === 'settings');
  const adds = t === 'searches' || t === 'flips';
  hb.innerHTML = adds ? PLUS_ICON : REFRESH_ICON;
  hb.setAttribute('aria-label', t === 'searches' ? 'New search' : t === 'flips' ? 'Add a flip' : 'Refresh');
  if (t === 'settings') loadSettings();
  if (t === 'flips') loadFlips();
  if (t === 'searches') loadSearches();
  if (t === 'deals') loadDeals();
}
$$('nav.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#headerAction').addEventListener('click', () => (tab === 'searches' ? openSearchForm() : tab === 'flips' ? addFlipManually() : loadDeals(true)));
$('#goSettings').addEventListener('click', (e) => { e.preventDefault(); setTab('settings'); });

/* ---------- deals ---------- */
$$('#dealFilter .chip').forEach((c) => c.addEventListener('click', () => {
  dealFilter = c.dataset.f;
  $$('#dealFilter .chip').forEach((x) => x.classList.toggle('on', x === c));
  renderDeals();
}));

async function loadDeals(manual) {
  hits = await api('/api/hits?limit=200');
  renderDeals();
  if (manual) toast('Up to date');
}

function messageFor(hit) {
  const s = searches.find((x) => x.id === hit.searchId);
  // Only mentions collecting on Facebook/Gumtree, or when the listing itself mentions collection.
  return buildMessage(s?.messageTemplate || DEFAULT_TEMPLATE, hit.listing);
}

function renderDeals() {
  const bestOf = (h) => h.estimate?.bestProfit ?? h.estimate?.profit ?? null;
  let list = hits.filter((h) => h.status !== 'flagged');
  if (dealFilter === 'saved') list = list.filter((h) => h.status === 'saved');
  if (dealFilter === 'profit') list = list.filter((h) => bestOf(h) > 0).sort((a, b) => bestOf(b) - bestOf(a));
  if (dealFilter === 'drops') list = list.filter((h) => h.listing.previousPrice != null);
  if (dealFilter === 'flagged') list = hits.filter((h) => h.status === 'flagged');
  const el = $('#deals');
  if (!list.length) {
    el.innerHTML = searches.length || dealFilter !== 'all'
      ? '<div class="empty"><b>No deals yet</b>New matches will show up here, and you\'ll get a ping the moment they\'re posted.</div>'
      : '<div class="empty"><b>Add your first search</b>Tell Deal Pinger what you flip and it will watch every marketplace for you.<br><br><button class="btn primary" id="firstSearch">New search</button></div>';
    $('#firstSearch')?.addEventListener('click', () => { setTab('searches'); openSearchForm(); });
    return;
  }
  el.innerHTML = list.map((h) => {
    const l = h.listing;
    const e = h.estimate;
    const chip = (n, label) => `<span class="profit ${n >= 0 ? 'up' : 'down'}">${n >= 0 ? '+' : '−'}${money(Math.abs(n))} ${label}</span>`;
    const profit = e?.profit != null ? chip(e.profit, 'profit') : '';
    const cexChip = e?.cex ? `<span class="cexchip">CeX ${chip(e.cex.cashProfit, 'cash').replace(/<[^>]+>/g, '')}</span>` : '';
    const scam = l.scam && l.scam.risk !== 'low'
      ? `<span class="scam ${esc(l.scam.risk)}">⚠️ ${l.scam.risk === 'high' ? 'Likely scam' : 'Check seller'}</span>` : '';
    const seller = l.seller ? [l.seller.name, l.seller.ratings != null ? `${l.seller.ratings} ratings` : null].filter(Boolean).join(' · ') : '';
    const valueLine = [e?.value != null ? `resells ~${money(e.value)}` : null, e?.cex ? `CeX sells ${money(e.cex.sell)}, pays ${money(e.cex.cash)} cash / ${money(e.cex.voucher)} voucher` : null].filter(Boolean).join(' · ');
    const buy = l.buyUrl && safeUrl(l.buyUrl) !== '#' && l.scam?.risk !== 'high';
    const img = l.image && safeUrl(l.image) !== '#' ? `data-img="${esc(l.image)}"` : '';
    const hot = e && e.score >= 50 ? '<span class="hot">🔥 Hot</span>' : '';
    const when = l.postedAt ? `listed ${ago(l.postedAt)}` : `found ${ago(h.createdAt)}`;
    return `<article class="card" data-id="${h.id}">
      <a class="deal" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">
        <div class="thumb" ${img}>${l.image ? '' : 'No photo'}</div>
        <div style="min-width:0">
          <div class="price">${money(l.price)}${l.previousPrice != null ? `<span class="was">${money(l.previousPrice)}</span>` : ''}</div>
          <div class="title">${esc(l.title)}</div>
          <div class="meta"><span class="badge b-${esc(l.source)}">${esc(srcLabel(l.source))}</span>${scam || hot}${l.previousPrice != null ? '<span class="drop">Price drop</span>' : ''}${profit}${cexChip}</div>
          <div class="meta">${esc(when)}${l.location ? ' · ' + esc(l.location) : ''}${seller ? ' · ' + esc(seller) : ''}</div>
          ${valueLine ? `<div class="meta">${esc(valueLine)}</div>` : ''}
          ${scam ? `<div class="warn">${esc(l.scam.reasons.join(' · '))}</div>` : ''}
        </div>
      </a>
      <div class="actions">
        ${buy ? `<a class="btn sm primary" data-act="buy" href="${esc(safeUrl(l.buyUrl))}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">Buy now</a>` : ''}
        <a class="btn sm ${buy ? '' : 'primary'}" data-act="msg" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">Message</a>
        ${h.status === 'flagged'
          ? '<button class="btn sm" data-act="unflag">Not a scam</button>'
          : `<button class="btn sm x" data-act="save" aria-label="Save">${h.status === 'saved' ? '★' : '☆'}</button>`}
        <button class="btn sm" data-act="bought">Bought</button>
        <button class="btn sm x" data-act="dismiss" aria-label="Hide">✕</button>
      </div>
    </article>`;
  }).join('');
  // Set images through the style API so a hostile URL can't inject CSS.
  $$('.thumb[data-img]', el).forEach((t) => { t.style.backgroundImage = `url(${JSON.stringify(t.dataset.img)})`; });
}

$('#deals').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const card = e.target.closest('article');
  const hit = hits.find((h) => h.id === Number(card.dataset.id));
  if (act === 'buy') return; // the link opens checkout
  if (act === 'unflag') {
    e.preventDefault();
    await api(`/api/hits/${hit.id}`, { method: 'PUT', body: { status: 'new' } });
    hit.status = 'new';
    renderDeals();
    toast('Moved back to your deals');
    return;
  }
  if (act === 'msg') {
    // Keep this synchronous so iOS treats the link open as a user gesture.
    navigator.clipboard?.writeText(messageFor(hit)).then(() => toast('Message copied. Paste it to the seller.'), () => {});
    return;
  }
  e.preventDefault();
  if (act === 'bought') {
    const paid = prompt('What did you pay? (£)', hit.listing.price ?? '');
    if (paid == null) return;
    try {
      await api('/api/flips', { method: 'POST', body: { hitId: hit.id, boughtPrice: paid } });
      hit.status = 'saved';
      renderDeals();
      toast('Added to Flips. Mark it sold when it goes.');
    } catch (err) { toast(err.message); }
    return;
  }
  const status = act === 'dismiss' ? 'dismissed' : hit.status === 'saved' ? 'new' : 'saved';
  await api(`/api/hits/${hit.id}`, { method: 'PUT', body: { status } });
  if (status === 'dismissed') hits = hits.filter((h) => h !== hit); else hit.status = status;
  renderDeals();
});

/* ---------- searches ---------- */
async function loadSearches() {
  searches = await api('/api/searches');
  renderSearches();
}

function renderSearches() {
  const el = $('#searches');
  if (!searches.length) {
    el.innerHTML = '<div class="empty"><b>No searches yet</b>Tap + to tell Deal Pinger what to watch for.</div>';
    return;
  }
  el.innerHTML = searches.map((s) => {
    const lo = s.minPrice, hi = s.maxPrice;
    const price = lo != null && hi != null ? ` · ${money(lo)}–${money(hi)}`
      : hi != null ? ` · up to ${money(hi)}`
      : lo != null ? ` · ${money(lo)}+` : '';
    return `<div class="row" data-id="${s.id}">
      <div class="grow" data-act="edit" style="cursor:pointer">
        <div class="sname">${esc(s.name)}</div>
        <div class="sub">${esc(s.keywords)}${price} · every ${everyLabel(s.intervalSec)} · ${s.sources.map(srcLabel).map(esc).join(', ')}</div>
      </div>
      <label class="switch"><input type="checkbox" data-act="toggle" ${s.enabled ? 'checked' : ''}><span></span></label>
    </div>`;
  }).join('');
}

$('#searches').addEventListener('click', async (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const s = searches.find((x) => x.id === Number(row.dataset.id));
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'edit') openSearchForm(s);
});
$('#searches').addEventListener('change', async (e) => {
  if (e.target.dataset.act !== 'toggle') return;
  const id = Number(e.target.closest('.row').dataset.id);
  const updated = await api(`/api/searches/${id}`, { method: 'PUT', body: { enabled: e.target.checked } });
  searches = searches.map((s) => (s.id === id ? updated : s));
  toast(updated.enabled ? 'Watching again' : 'Paused');
});

function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').classList.remove('hidden');
}
function closeSheet() { $('#sheet').classList.add('hidden'); }
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet' || e.target.closest('[data-close]')) closeSheet(); });

const EVERY = [[15, '15 seconds'], [30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes'], [900, '15 minutes']];
function everyLabel(sec) {
  const hit = EVERY.find(([n]) => n === sec);
  return hit ? hit[1].replace(' seconds', 's').replace(' minutes', ' min').replace(' minute', ' min') : `${sec}s`;
}

function openSearchForm(existing = null, { copy = false } = {}) {
  // A copy starts as a new search pre-filled from an existing one.
  const s = copy ? null : existing;
  const src = existing;
  const v = (k, d = '') => esc((k === 'name' && copy ? `${src.name} (copy)` : src?.[k]) ?? d);
  const every = src?.intervalSec ?? 60;
  const srcs = SOURCES.map((x) => `<label><input type="checkbox" name="sources" value="${x.id}" ${!src || src.sources.includes(x.id) ? 'checked' : ''}> ${esc(x.label)}</label>`).join('');
  openSheet(`
    <h2>${s ? 'Edit search' : copy ? 'Copy of search' : 'New search'} <button class="icon-btn" data-close aria-label="Close">✕</button></h2>
    <form id="searchForm">
      <label class="f"><span>What are you looking for?</span><input class="t" name="keywords" value="${v('keywords')}" placeholder="nintendo switch oled" required></label>
      <label class="f"><span>Name (optional)</span><input class="t" name="name" value="${v('name')}" placeholder="Switch flips"></label>
      <div class="two">
        <label class="f"><span>Min price (£)</span><input class="t" name="minPrice" inputmode="decimal" value="${v('minPrice')}" placeholder="0"></label>
        <label class="f"><span>Max price (£)</span><input class="t" name="maxPrice" inputmode="decimal" value="${v('maxPrice')}" placeholder="Any"></label>
      </div>
      <div class="two">
        <label class="f"><span>Postcode</span><input class="t" name="zip" autocapitalize="characters" value="${v('zip')}" placeholder="SW1A 1AA"></label>
        <label class="f"><span>Radius (miles)</span><input class="t" name="radius" inputmode="numeric" value="${v('radius', 25)}"></label>
      </div>
      <label class="f"><span>Check every</span><select class="t" name="intervalSec">${EVERY.map(([n, l]) => `<option value="${n}" ${n === every ? 'selected' : ''}>${l}${n === 15 ? ' (fastest, Vinted & eBay)' : ''}</option>`).join('')}</select><span class="hint">Facebook, Gumtree and Depop are checked at most every 45 seconds.</span></label>
      <label class="f"><span>Skip listings containing (comma separated)</span><input class="t" name="excludeWords" value="${v('excludeWords')}" placeholder="broken, parts, box only, read"></label>
      <div class="f"><span style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">Marketplaces</span><div class="srcs">${srcs}</div></div>
      <div class="two" style="margin-top:14px">
        <label class="f"><span>Only ping if profit ≥ £</span><input class="t" name="minProfit" inputmode="decimal" value="${v('minProfit')}" placeholder="Always ping"></label>
        <label class="f"><span>Postage cost (£)</span><input class="t" name="shipEstimate" inputmode="decimal" value="${v('shipEstimate', 4)}"></label>
      </div>
      <label class="f"><span>I can resell these for (£)</span><input class="t" name="resaleOverride" inputmode="decimal" value="${v('resaleOverride')}" placeholder="Leave empty to use eBay sold prices"></label>
      <div class="f"><span style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">CeX price</span>
        <input type="hidden" name="cexBoxId" value="${v('cexBoxId')}"><input type="hidden" name="cexName" value="${v('cexName')}"><input type="hidden" name="cexMode" value="${v('cexMode', 'auto')}">
        <div class="sub" id="cexChoice" style="white-space:normal;margin-bottom:8px"></div>
        <div style="display:flex;gap:8px"><button type="button" class="btn sm" id="cexFind">Pick CeX item</button><button type="button" class="btn sm" id="cexAuto">Auto</button><button type="button" class="btn sm" id="cexOff">Off</button></div>
        <div class="card cexlist" id="cexResults" style="margin-top:8px"></div>
      </div>
      <label class="f"><span>Seller message</span><textarea class="t" name="messageTemplate" rows="2">${v('messageTemplate', DEFAULT_TEMPLATE)}</textarea>
        <span class="hint">{offer} = about 85% of the price. {collect} becomes "I can collect today." only on Facebook/Gumtree or when the listing mentions collection; otherwise anything about collecting is left out.</span></label>
      <label class="f"><span>Send this search to its own Discord channel (optional)</span><input class="t" name="discordWebhook" placeholder="${s?.hasDiscordWebhook ? 'Own channel set. Paste a new link to change it.' : 'https://discord.com/api/webhooks/…'}" autocomplete="off">
        ${s?.hasDiscordWebhook ? '<label style="display:flex;gap:6px;align-items:center;margin-top:6px;font-size:14px"><input type="checkbox" name="clearDiscord"> Stop using its own channel</label>' : ''}</label>
      <div class="err" id="formErr"></div>
      <button class="btn primary" style="width:100%">${s ? 'Save' : 'Start watching'}</button>
      ${s ? `<div style="display:flex;gap:8px;margin-top:10px">
        <button type="button" class="btn" style="flex:1" id="runNow">Check now</button>
        <button type="button" class="btn" style="flex:1" id="showHistory">Price history</button></div>
        <div style="display:flex;gap:8px;margin-top:8px">
        <button type="button" class="btn" style="flex:1" id="dupSearch">Duplicate</button>
        <button type="button" class="btn danger" style="flex:1" id="delSearch">Delete</button></div>
        <div id="history"></div>` : ''}
    </form>`);

  $('#searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries([...fd.entries()].filter(([k]) => k !== 'sources' && k !== 'clearDiscord'));
    body.sources = fd.getAll('sources');
    // Leave the saved Discord channel alone unless a new one is pasted or it's cleared.
    if (fd.get('clearDiscord')) body.discordWebhook = '';
    else if (!body.discordWebhook) delete body.discordWebhook;
    try {
      if (s) await api(`/api/searches/${s.id}`, { method: 'PUT', body });
      else await api('/api/searches', { method: 'POST', body });
      closeSheet();
      await loadSearches();
      toast(s ? 'Saved' : 'Watching. You\'ll get a ping for new listings.');
    } catch (err) { $('#formErr').textContent = err.message; }
  });
  setupCexPicker();
  if (!s) return;
  $('#dupSearch').addEventListener('click', () => openSearchForm(s, { copy: true }));
  $('#delSearch').addEventListener('click', async () => {
    if (!confirm(`Delete "${s.name}" and its deals?`)) return;
    await api(`/api/searches/${s.id}`, { method: 'DELETE' });
    closeSheet();
    loadSearches();
  });
  $('#runNow').addEventListener('click', async (e) => {
    e.target.textContent = 'Checking…';
    e.target.disabled = true;
    try {
      const r = await api(`/api/searches/${s.id}/run`, { method: 'POST' });
      toast(r.errors.length ? `${r.newHits} new · ${r.errors.map((x) => srcLabel(x.source)).join(', ')} failed` : `${r.newHits} new deal${r.newHits === 1 ? '' : 's'}`);
    } catch (err) {
      toast(err.message);
    } finally { e.target.textContent = 'Check now'; e.target.disabled = false; }
  });
  $('#showHistory').addEventListener('click', () => showHistory(s));
}

async function showHistory(s) {
  const h = await api(`/api/searches/${s.id}/history`);
  const el = $('#history');
  if (!h.points.length) { el.innerHTML = '<p class="sub" style="white-space:normal;margin-top:14px">No prices collected yet. Check back after a few polls.</p>'; return; }
  const W = 600, H = 160, P = 8;
  const prices = h.points.map((p) => p.price);
  const all = prices.concat(h.soldMedian != null ? [h.soldMedian] : []);
  const lo = Math.min(...all), hi = Math.max(...all);
  // Plot in the order listings were seen (oldest left), so bursts seen at the same time stay readable.
  const x = (i) => P + (i / Math.max(1, prices.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - lo) / Math.max(1, hi - lo)) * (H - 2 * P);
  const dots = h.points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.price).toFixed(1)}" r="7" fill="var(--accent)" opacity=".6"/>`).join('');
  const sold = h.soldMedian != null ? `<line x1="${P}" x2="${W - P}" y1="${y(h.soldMedian)}" y2="${y(h.soldMedian)}" stroke="var(--good)" stroke-width="3" stroke-dasharray="10 8"/>` : '';
  el.innerHTML = `<div class="card" style="padding:14px;margin-top:14px">
    <div class="sname">Asking prices</div>
    <div class="sub" style="white-space:normal">${h.points.length} listings · median ask ${money(h.askMedian)}${h.soldMedian != null ? ` · eBay UK sold median ${money(h.soldMedian)} (${h.soldCount} sales)` : ''}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Asking price history">${sold}${dots}</svg>
    <div class="legend"><span>${money(lo)} – ${money(hi)} · oldest → newest</span><span style="color:var(--accent)">● asking</span>${sold ? '<span style="color:var(--good)">┅ sold median</span>' : ''}</div>
  </div>`;
}

/* ---------- settings & push ---------- */
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return isIOS() && !isStandalone() ? 'install' : 'unsupported';
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : Notification.permission === 'denied' ? 'denied' : 'off';
}

// Make sure the server still knows this device: it may have dropped the subscription,
// or the server's push keys may have changed (e.g. the Railway volume was replaced).
async function resyncPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const { publicKey } = await api('/api/vapid');
  if (!publicKey) return;
  const want = urlB64ToUint8Array(publicKey);
  const have = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  const same = have && have.length === want.length && have.every((b, i) => b === want[i]);
  if (!same) {
    await sub.unsubscribe();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  }
  await api('/api/subscribe', { method: 'POST', body: sub.toJSON() });
}

async function refreshPushUi() {
  const st = await pushState();
  const labels = {
    on: 'On for this device',
    off: 'Off',
    denied: 'Blocked. Allow it in iPhone Settings → Notifications → Deal Pinger',
    install: 'Add to Home Screen first (Share → Add to Home Screen)',
    unsupported: 'Not supported in this browser',
  };
  $('#pushState').textContent = labels[st];
  $('#enablePush').classList.toggle('hidden', st !== 'off');
  $('#installNote').classList.toggle('hidden', st !== 'install');
  $('#alertsNote').classList.toggle('hidden', st !== 'off');
}

$('#enablePush').addEventListener('click', async () => {
  try {
    const { publicKey } = await api('/api/vapid');
    if (!publicKey) return toast('Push keys are not set up on the server yet');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return refreshPushUi();
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
    await api('/api/subscribe', { method: 'POST', body: sub.toJSON() });
    toast('Alerts on');
  } catch (err) { toast(err.message); }
  refreshPushUi();
});

$('#testPush').addEventListener('click', async () => {
  const r = await api('/api/test-push', { method: 'POST' });
  toast(r.sent ? 'Test alert sent' : 'No devices have alerts turned on yet');
});

async function saveQuiet() {
  try {
    await api('/api/settings', { method: 'PUT', body: { quietStart: $('#quietStart').value, quietEnd: $('#quietEnd').value } });
    toast('Quiet hours saved');
  } catch (err) { toast(err.message); }
}
$('#feePct').addEventListener('change', async () => {
  try {
    await api('/api/settings', { method: 'PUT', body: { feePct: $('#feePct').value || 0 } });
    toast('Selling fee saved');
  } catch (err) { toast(err.message); }
});
$('#scamFilter').addEventListener('change', async () => {
  try { await api('/api/settings', { method: 'PUT', body: { scamFilter: $('#scamFilter').value } }); toast('Scam filter saved'); } catch (err) { toast(err.message); }
});
$('#quietStart').addEventListener('change', saveQuiet);
$('#quietEnd').addEventListener('change', saveQuiet);

$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); showLogin(); });

async function loadSettings() {
  refreshPushUi();
  const [settings, status] = await Promise.all([api('/api/settings'), api('/api/status')]);
  $('#quietStart').value = settings.quietStart || '';
  $('#quietEnd').value = settings.quietEnd || '';
  $('#feePct').value = settings.feePct || '';
  renderChannels(settings);
  $('#scamFilter').value = settings.scamFilter || 'hide';
  const took = (ms) => (ms == null ? '' : ` · took ${ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'}`);
  $('#status').innerHTML = status.sources.map((s) => {
    const cls = s.ok === true ? 'ok' : s.ok === false ? 'bad' : '';
    const sub = s.ok === undefined ? 'Not checked yet'
      : s.ok ? `Working · ${s.count} listings · checked ${ago(s.at)}${took(s.ms)}`
      : `Failing: ${s.error} · ${ago(s.at)}`;
    const extra = s.id === 'ebay' ? (status.ebayApi ? ' · official API' : ' · no API keys, reading the website') : '';
    return `<div class="row"><span class="dot ${cls}"></span><div class="grow"><div class="sname">${esc(s.label)}</div><div class="sub" style="white-space:normal">${esc(sub + extra)}</div></div></div>`;
  }).join('') + `<div class="row"><div class="grow sub" style="white-space:normal">Each search checks on its own timer (set it when editing a search) · ${status.subscriptions} iPhone(s) getting alerts</div></div>`;
}


/* ---------- CeX picker (inside the search form) ---------- */
function setupCexPicker() {
  const form = $('#searchForm');
  const show = () => {
    const mode = form.cexMode.value;
    $('#cexChoice').textContent = mode === 'off' ? 'Off: no CeX prices for this search.'
      : form.cexBoxId.value ? `Pinned: ${form.cexName.value || form.cexBoxId.value}`
      : 'Auto: uses the CeX item that matches all your keywords (if any).';
  };
  show();
  $('#cexAuto').addEventListener('click', () => { form.cexMode.value = 'auto'; form.cexBoxId.value = ''; form.cexName.value = ''; $('#cexResults').innerHTML = ''; show(); });
  $('#cexOff').addEventListener('click', () => { form.cexMode.value = 'off'; $('#cexResults').innerHTML = ''; show(); });
  $('#cexFind').addEventListener('click', async () => {
    const q = form.keywords.value.trim();
    if (!q) return toast('Type what you\'re looking for first');
    $('#cexResults').innerHTML = '<div class="row sub">Searching CeX…</div>';
    try {
      const boxes = await api(`/api/cex/search?q=${encodeURIComponent(q)}`);
      $('#cexResults').innerHTML = boxes.length ? boxes.map((b, i) => `<div class="row" data-i="${i}"><div class="grow"><div class="sname" style="white-space:normal">${esc(b.name)}</div><div class="sub">sells ${money(b.sell)} · cash ${money(b.cash)} · voucher ${money(b.voucher)}</div></div></div>`).join('')
        : '<div class="row sub">Nothing found on CeX for that.</div>';
      $$('#cexResults .row[data-i]').forEach((r) => r.addEventListener('click', () => {
        const b = boxes[Number(r.dataset.i)];
        form.cexMode.value = 'auto'; form.cexBoxId.value = b.id; form.cexName.value = b.name;
        $('#cexResults').innerHTML = '';
        show();
      }));
    } catch (err) { $('#cexResults').innerHTML = `<div class="row sub">${esc(err.message)}</div>`; }
  });
}

/* ---------- flips ---------- */
let flips = [];

async function loadFlips() {
  const r = await api('/api/flips');
  flips = r.flips;
  const s = r.summary;
  const signed = (n) => (n >= 0 ? '' : '−') + money(Math.abs(n));
  $('#flipStats').innerHTML = `
    <div class="stat"><div class="k">Profit this month</div><div class="v ${s.monthProfit >= 0 ? 'up' : 'down'}">${signed(s.monthProfit)}</div></div>
    <div class="stat"><div class="k">Total profit</div><div class="v ${s.totalProfit >= 0 ? 'up' : 'down'}">${signed(s.totalProfit)}</div></div>
    <div class="stat"><div class="k">In stock</div><div class="v">${s.stockCount}</div><div class="k">${money(s.stockValue)} tied up</div></div>
    <div class="stat"><div class="k">Return on sold</div><div class="v">${s.roiPct == null ? '—' : s.roiPct + '%'}</div><div class="k">${s.soldCount} sold</div></div>`;
  const el = $('#flips');
  if (!flips.length) {
    el.innerHTML = '<div class="empty"><b>No flips yet</b>Tap <b>Bought</b> on a deal, or + to add one, and track what you make.</div>';
    return;
  }
  el.innerHTML = flips.map((f) => {
    const profit = f.soldPrice != null ? f.soldPrice - f.boughtPrice - f.fees : null;
    const right = profit != null
      ? `<div class="p" style="color:${profit >= 0 ? 'var(--good)' : 'var(--bad)'}">${profit >= 0 ? '+' : '−'}${money(Math.abs(Math.round(profit * 100) / 100))}</div><div class="sub">sold ${money(f.soldPrice)}</div>`
      : `<button class="btn sm primary" data-act="sell">Sold</button>`;
    return `<div class="row flip" data-id="${f.id}">
      <div class="grow" data-act="edit" style="cursor:pointer">
        <div class="sname" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.title)}</div>
        <div class="sub">${f.source ? esc(srcLabel(f.source)) + ' · ' : ''}paid ${money(f.boughtPrice)} · ${esc(ago(f.boughtAt))}</div>
      </div>
      <div class="r">${right}</div>
    </div>`;
  }).join('');
}

async function addFlipManually() {
  const title = prompt('What did you buy?');
  if (!title) return;
  const paid = prompt('What did you pay? (£)');
  if (paid == null) return;
  try { await api('/api/flips', { method: 'POST', body: { title, boughtPrice: paid } }); loadFlips(); } catch (err) { toast(err.message); }
}

$('#flips').addEventListener('click', async (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const f = flips.find((x) => x.id === Number(row.dataset.id));
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'sell') {
    const sold = prompt(`Sold "${f.title}" for? (£)`);
    if (sold == null || sold === '') return;
    const fees = prompt('Any fees or postage you paid? (£)', '0');
    try { await api(`/api/flips/${f.id}`, { method: 'PUT', body: { soldPrice: sold, fees: fees || 0 } }); toast('Nice flip!'); loadFlips(); } catch (err) { toast(err.message); }
  }
  if (act === 'edit') openFlipSheet(f);
});

function openFlipSheet(f) {
  openSheet(`
    <h2>Edit flip <button class="icon-btn" data-close aria-label="Close">✕</button></h2>
    <form id="flipForm">
      <label class="f"><span>Item</span><input class="t" name="title" value="${esc(f.title)}" required></label>
      <div class="two">
        <label class="f"><span>Paid (£)</span><input class="t" name="boughtPrice" inputmode="decimal" value="${esc(f.boughtPrice)}"></label>
        <label class="f"><span>Sold for (£)</span><input class="t" name="soldPrice" inputmode="decimal" value="${esc(f.soldPrice ?? '')}" placeholder="Not sold yet"></label>
      </div>
      <label class="f"><span>Fees and postage (£)</span><input class="t" name="fees" inputmode="decimal" value="${esc(f.fees)}"></label>
      <label class="f"><span>Notes</span><textarea class="t" name="notes" rows="2">${esc(f.notes)}</textarea></label>
      ${f.url && safeUrl(f.url) !== '#' ? `<p><a class="linkish" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener">Open original listing</a></p>` : ''}
      <div class="err" id="flipErr"></div>
      <button class="btn primary" style="width:100%">Save</button>
      <button type="button" class="btn danger" style="width:100%;margin-top:8px" id="delFlip">Delete</button>
    </form>`);
  $('#flipForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try { await api(`/api/flips/${f.id}`, { method: 'PUT', body }); closeSheet(); loadFlips(); } catch (err) { $('#flipErr').textContent = err.message; }
  });
  $('#delFlip').addEventListener('click', async () => {
    if (!confirm(`Delete "${f.title}"?`)) return;
    await api(`/api/flips/${f.id}`, { method: 'DELETE' });
    closeSheet();
    loadFlips();
  });
}

/* ---------- Telegram & Discord ---------- */
let lastSettings = null;
function renderChannels(st) {
  lastSettings = st;
  $('#tgState').textContent = st.telegramConnected ? 'Connected' : st.telegramHasToken ? 'Bot added. Send /start to it in Telegram, then tap Set up → Link.' : 'Not connected';
  $('#tgSetup').textContent = st.telegramConnected ? 'Change' : 'Set up';
  $('#dcState').textContent = st.discordConnected ? 'Connected' : 'Not connected';
  $('#dcSetup').textContent = st.discordConnected ? 'Change' : 'Set up';
}

$('#tgSetup').addEventListener('click', () => {
  openSheet(`
    <h2>Telegram alerts <button class="icon-btn" data-close aria-label="Close">✕</button></h2>
    <ol style="padding-left:20px;line-height:1.6;margin-top:0">
      <li>In Telegram, message <b>@BotFather</b>, send <b>/newbot</b> and follow the steps.</li>
      <li>Paste the token it gives you below and tap <b>Save</b>.</li>
      <li>Open your new bot in Telegram and send it <b>/start</b>.</li>
      <li>Come back and tap <b>Link</b>.</li>
    </ol>
    <label class="f"><span>Bot token</span><input class="t" id="tgToken" placeholder="123456789:AA..." autocomplete="off"></label>
    <div class="err" id="tgErr"></div>
    <div style="display:flex;gap:8px">
      <button class="btn primary" style="flex:1" id="tgSave">Save</button>
      <button class="btn" style="flex:1" id="tgLink">Link</button>
      <button class="btn danger" style="flex:1" id="tgRemove">Remove</button>
    </div>`);
  const fail = (err) => { $('#tgErr').textContent = err.message; };
  $('#tgSave').addEventListener('click', async () => {
    try { renderChannels(await api('/api/settings', { method: 'PUT', body: { telegramBotToken: $('#tgToken').value } })); toast('Saved. Now send /start to your bot, then tap Link.'); } catch (err) { fail(err); }
  });
  $('#tgLink').addEventListener('click', async () => {
    try {
      await api('/api/telegram/link', { method: 'POST' });
      renderChannels(await api('/api/settings'));
      await api('/api/test-push', { method: 'POST' });
      closeSheet();
      toast('Telegram linked. Check for a test message.');
    } catch (err) { fail(err); }
  });
  $('#tgRemove').addEventListener('click', async () => { renderChannels(await api('/api/settings', { method: 'PUT', body: { telegramBotToken: '' } })); closeSheet(); });
});

$('#dcSetup').addEventListener('click', () => {
  openSheet(`
    <h2>Discord alerts <button class="icon-btn" data-close aria-label="Close">✕</button></h2>
    <p style="margin-top:0">In your Discord server: <b>Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL</b>, then paste it here.</p>
    <label class="f"><span>Webhook URL</span><input class="t" id="dcUrl" placeholder="${lastSettings?.discordConnected ? 'Connected. Paste a new link to change it.' : 'https://discord.com/api/webhooks/...'}" autocomplete="off"></label>
    <label class="f"><span>Ping people with each alert</span><select class="t" id="dcMention">
      <option value="">Nobody (just post)</option><option value="@here">@here (people online)</option><option value="@everyone">@everyone</option><option value="role">A role…</option></select></label>
    <label class="f hidden" id="dcRoleWrap"><span>Role ID</span><input class="t" id="dcRole" inputmode="numeric" placeholder="Server settings → Roles → ⋯ → Copy Role ID"></label>
    <p class="sub" style="white-space:normal">Each search can also post to its own channel: edit the search and paste that channel's webhook.</p>
    <div class="err" id="dcErr"></div>
    <div style="display:flex;gap:8px">
      <button class="btn primary" style="flex:1" id="dcSave">Save &amp; test</button>
      <button class="btn danger" style="flex:1" id="dcRemove">Remove</button>
    </div>`);
  const cur = lastSettings?.discordMention || '';
  $('#dcMention').value = /^\d+$/.test(cur) ? 'role' : cur;
  $('#dcRole').value = /^\d+$/.test(cur) ? cur : '';
  const roleUi = () => $('#dcRoleWrap').classList.toggle('hidden', $('#dcMention').value !== 'role');
  roleUi();
  $('#dcMention').addEventListener('change', roleUi);
  $('#dcSave').addEventListener('click', async () => {
    try {
      const mention = $('#dcMention').value === 'role' ? $('#dcRole').value.trim() : $('#dcMention').value;
      const body = { discordMention: mention };
      if ($('#dcUrl').value.trim()) body.discordWebhook = $('#dcUrl').value.trim();
      else if (!lastSettings?.discordConnected) throw new Error('Paste your Discord webhook link');
      renderChannels(await api('/api/settings', { method: 'PUT', body }));
      await api('/api/test-push', { method: 'POST' });
      closeSheet();
      toast('Discord connected. Check the channel for a test message.');
    } catch (err) { $('#dcErr').textContent = err.message; }
  });
  $('#dcRemove').addEventListener('click', async () => { renderChannels(await api('/api/settings', { method: 'PUT', body: { discordWebhook: '' } })); closeSheet(); });
});

/* ---------- boot ---------- */
async function start() {
  try {
    SOURCES = await api('/api/sources');
  } catch { return; }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  searches = await api('/api/searches');
  setTab('deals');
  resyncPush().catch(() => {}).finally(refreshPushUi);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
document.addEventListener('visibilitychange', () => { if (!document.hidden && tab === 'deals' && !$('#app').classList.contains('hidden')) loadDeals().catch(() => {}); });
setInterval(() => { if (!document.hidden && tab === 'deals' && !$('#app').classList.contains('hidden')) loadDeals().catch(() => {}); }, 30000);
start();
