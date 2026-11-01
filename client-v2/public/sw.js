// ── Service worker ───────────────────────────────────────────────────
// Makes /v2 installable as a phone app. The app needs the server, so this
// does not try to run offline: pages always come from the network (a new
// deploy shows up straight away), with a "You're offline" page when there
// is no connection. Built assets have content-hashed names and never
// change, so they are kept to make launches quick. /api is never touched.

const SHELL = 'auav-shell-v1';
const ASSETS = 'auav-assets-v1';
const OFFLINE = 'offline.html';
const KEEP_ASSETS = 60;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll([OFFLINE, 'icons/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - KEEP_ASSETS)).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match(new URL(OFFLINE, self.registration.scope).href)),
    );
    return;
  }

  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone()).then(() => trim(cache));
        return res;
      }),
    );
    return;
  }

  // Anything else under /v2 (icons, letterhead): the network, or the copy
  // kept for the offline page.
  if (url.pathname.startsWith(new URL(self.registration.scope).pathname) && !url.pathname.includes('/api/')) {
    event.respondWith(fetch(req).catch(() => caches.match(req).then((hit) => hit || Response.error())));
  }
});
