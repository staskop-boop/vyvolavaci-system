// Service worker: ukladá do vyrovnávacej pamäte IBA súbory aplikácie (nie údaje z API).
const CACHE = 'adna-sestra-v1';
const SHELL = ['/sestra/', '/sestra/index.html', '/sestra/app.js', '/sestra/styles.css', '/sestra/icon.svg',
  '/sestra/manifest.webmanifest', '/shared/adna-client.js', '/shared/adna-theme.css'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return; // údaje vždy zo servera
  if (!SHELL.includes(url.pathname)) return;
  // Najprv sieť (aby sa aktualizácie prejavili hneď), pri výpadku verzia z pamäte.
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
