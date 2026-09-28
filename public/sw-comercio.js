// Tapy: avisos del club de fidelidad en el celular del comercio.
// Este archivo recibe el aviso (aunque el panel este cerrado) y lo muestra como notificacion.
// Al tocar la notificacion se abre el panel directo en esa moneda, para poder advertirla.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let datos = {};
  try { datos = event.data ? event.data.json() : {}; } catch (e) { datos = {}; }
  const titulo = datos.title || "Tapy: actividad en tu club";
  const opciones = {
    body: datos.body || "Alguien sumó una moneda en tu club.",
    icon: "/tapy-icon-192.png",
    badge: "/tapy-badge.png",
    tag: datos.tag || undefined,
    renotify: !!datos.tag,
    vibrate: [120, 60, 120],
    data: { url: datos.url || "/comercio.html" }
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(titulo, opciones);
    // Si el panel esta abierto, que se actualice al instante.
    const ventanas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    ventanas.forEach((v) => v.postMessage({ tipo: "actividad" }));
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destino = new URL((event.notification.data && event.notification.data.url) || "/comercio.html", self.location.origin).href;
  event.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const v of ventanas) {
      if (new URL(v.url).pathname.startsWith("/comercio")) {
        await v.focus();
        v.postMessage({ tipo: "abrir", url: destino });
        return;
      }
    }
    await self.clients.openWindow(destino);
  })());
});
