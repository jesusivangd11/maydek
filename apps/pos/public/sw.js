/**
 * Service worker del punto de venta — modo sin conexión NIVEL 0.
 *
 * Qué garantiza: sin internet la caja sigue ABRIENDO, y muestra el catálogo,
 * los precios y la última existencia conocida (lo último que consultó).
 * Qué NO hace: vender sin conexión. Cobrar exige al servidor, porque es quien
 * bloquea la existencia y asigna el folio; vender a ciegas permitiría vender
 * dos veces la última pieza. El nivel 1 (venta en efectivo diferida) es una
 * decisión pendiente del roadmap.
 *
 * Estrategias:
 *   · Interfaz (HTML, JS, CSS, fuentes): primero caché, se actualiza detrás.
 *   · Catálogo y categorías del API: primero red; si no hay red, la copia.
 *   · Todo lo demás del API (ventas, caja, sesión): SOLO red. Nunca se sirve
 *     una respuesta vieja de algo que mueve dinero.
 */

const SHELL = 'pv-shell-v2';
const DATA = 'pv-data-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/brand/icon-192.png', '/brand/maydek-logo.png', '/brand/maydek-lockup.png', '/brand/maydek-mark.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isCatalogRead(url) {
  return /\/api\/v1\/(pos\/search|categories)(\?|$)/.test(url.pathname + url.search);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/') || url.port === '3100') {
    if (!isCatalogRead(url)) return;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(DATA).then((cache) => cache.put(request.url, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request.url).then(
            (cached) =>
              cached ||
              new Response(JSON.stringify({ exactBarcode: false, warehouseId: '', data: [], offline: true }), {
                headers: { 'Content-Type': 'application/json' },
              }),
          ),
        ),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Navegación: la app es de una sola página, toda ruta sirve el índice.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
