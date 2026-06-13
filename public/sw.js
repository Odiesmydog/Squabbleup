const CACHE = 'squabbleup-v1';
const PRECACHE = ['/players-data.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
    if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
    return res;
  })));
});

// ── Push notifications ──────────────────────────────────────────────────────
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    // If user already has the app open and focused, skip the banner
    const cs = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (cs.some(c => c.focused)) return;

    const data = e.data ? e.data.json() : {};
    await self.registration.showNotification(data.title || 'SquabbleUP', {
      body: data.body || "It's your turn to pick!",
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'pick-turn',      // collapses multiple "your turn" notifications into one
      renotify: true,
      data: data.data || {},
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const code = e.notification.data?.draftCode;
  const url = code ? `/?join=${code}` : '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const existing = cs.find(c => c.url.includes(location.origin));
      if (existing) return existing.focus().then(c => c.navigate(url));
      return clients.openWindow(url);
    })
  );
});
