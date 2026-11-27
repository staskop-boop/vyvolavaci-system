// Service worker prehľadu: v pamäti len súbory aplikácie, nikdy údaje z API (údaje pacientov sa v telefóne neukladajú).
const CACHE = 'adna-prehlad-v4';
const SHELL = ['/prehlad/', '/prehlad/index.html', '/prehlad/app.js', '/prehlad/styles.css', '/prehlad/icon.svg', '/prehlad/adna-logo.png',
  '/prehlad/manifest.webmanifest', '/shared/adna-client.js', '/shared/adna-theme.css'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('adna-prehlad-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  if (!SHELL.includes(url.pathname)) return;
  const req = e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(fetch(req).then((r) => {
    const copy = r.clone(); if (r.ok) caches.open(CACHE).then((c) => c.put(url.pathname, copy)); return r;
  }).catch(() => caches.match(url.pathname)));
});
