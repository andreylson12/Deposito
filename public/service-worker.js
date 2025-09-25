const CACHE = "rs-delivery-v3"; // mude a versão quando fizer deploy novo

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([
      "/",
      "/delivery",
      "/delivery.html",
      "/style.css",
      "/script.js",
      "/manifest.json",
      "/icons/icon-192.png",
      "/icons/icon-512.png"
      // ⚠️ não coloque rotas /api aqui
    ]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API = network-first (nada de cache pra não "sumir" produto)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Arquivos estáticos = cache-first
  event.respondWith(
    caches.match(event.request).then(resp => resp || fetch(event.request))
  );
});
