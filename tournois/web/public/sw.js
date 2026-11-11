// Service worker minimal : coque de l'application disponible hors connexion ; les données (API) ne sont jamais
// servies depuis le cache, afin de ne jamais afficher un score ou un classement périmé comme s'il était à jour.
const SHELL = 'tournois-shell-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg']))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && url.origin === location.origin) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
    return res;
  })));
});
