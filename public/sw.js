const SHELL = 'deal-pinger-shell-v8';
const ASSETS = ['/', '/index.html', '/app.js', '/messages.js', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first for the app shell so updates land immediately; never cache the API.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request)),
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Deal Pinger', body: e.data?.text() }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'New deal', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag,
      data: { url: data.url || '/' },
    });
    // Home Screen icon badge = alerts waiting in Notification Centre.
    try {
      const shown = await self.registration.getNotifications();
      if (self.navigator.setAppBadge) await self.navigator.setAppBadge(shown.length);
    } catch {}
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data?.url || '/'));
});
