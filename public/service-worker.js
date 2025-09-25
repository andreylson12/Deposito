// public/service-worker.js
const CACHE = "rs-delivery-v6"; // 👈 versão nova

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll([
        // Pré-cache SOMENTE o que é público do delivery
        "/delivery",
        "/delivery.html",
        "/style.css",
        "/script.js",
        "/manifest.json?v=6",   // 👈 combine com o link do HTML
        "/icons/icon-192.png",
        "/icons/icon-512.png",
        // ⚠️ não coloque rotas /api aqui
      ])
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API = network-first (para sempre pegar a lista mais recente)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Demais arquivos estáticos = cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
