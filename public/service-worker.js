// public/service-worker.js
self.addEventListener("install", (e) => {
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// Exibe notificações quando chegar push do servidor
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch { payload = { title: "Novo pedido", body: event.data.text() }; }
  const { title = "Novo pedido", body = "", data = {} } = payload;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      vibrate: [80, 50, 80]
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = "/index.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      for (const c of clientsArr) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// (Opcional) cache simples
const CACHE = "adega-v1";
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      const fetched = fetch(event.request).then((resp) => {
        try { cache.put(event.request, resp.clone()); } catch {}
        return resp;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
