// Service worker minimal — § demande client "faire de la page une app
// PWA" (public/checkin.html, parcours client). Ne met en cache QUE la
// coquille statique (page elle-même, icônes, police d'icônes) : les appels
// /wa/* et /api/* (réservations, paiement, boutique, disponibilités…) ne
// sont JAMAIS mis en cache ici — une réponse périmée pourrait afficher au
// client un prix, un stock ou un statut de paiement faux. "Network first"
// pour la page (toujours la version la plus fraîche quand le réseau
// répond, repli sur le cache hors-ligne sinon), "cache first" pour les
// assets statiques versionnés.
const CACHE_NAME = "sesame-checkin-v1";
const APP_SHELL = [
  "/icons/favicon-32.png",
  "/icons/favicon-192.png",
  "/icons/apple-touch-icon.png",
  "/vendor/tabler-icons/tabler-icons.min.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/wa/") || url.pathname.startsWith("/api/")) return; // jamais l'API métier

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("/")))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
    )
  );
});
