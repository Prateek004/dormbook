/**
 * DormBook Service Worker — v4.1
 * Implements:
 *   - Network-first for app files (offline fallback from cache)
 *   - API calls never cached; writes are never queued offline
 *
 * IMPORTANT: Bump CACHE_VERSION on every deploy that changes static files.
 */

const CACHE_VERSION   = 'dormbook-v4.6';
const STATIC_CACHE    = `${CACHE_VERSION}-static`;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/manifest.json',
];

// ── Install: cache static assets ───────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ─────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k.startsWith('dormbook-') && k !== STATIC_CACHE)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: routing strategy ────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls: always go to the server. Responses are never cached — they hold
  // private data, and a stale copy could show another user's (or a deleted
  // account's) data on a shared device.
  if (url.pathname.startsWith('/api/')) {
    if (event.request.method === 'GET') event.respondWith(apiGet(event.request));
    else event.respondWith(handleMutation(event.request));
    return;
  }

  // App files: network-first so every deploy reaches users immediately;
  // the cached copy is used only when offline.
  if (event.request.method === 'GET' && url.origin === self.location.origin) {
    event.respondWith(networkFirst(event.request, STATIC_CACHE));
  }
});

async function apiGet(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(JSON.stringify({ error: 'You are offline. Please check your internet.', offline: true }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await caches.match(request) || (request.mode === 'navigate' ? await caches.match('/index.html') : null);
    return cached || new Response('Offline — please check your internet', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function handleMutation(request) {
  try {
    return await fetch(request);
  } catch {
    // Do NOT queue money/check-in writes offline. Replaying a request whose
    // response was merely lost could record a payment twice. Tell the user
    // plainly that nothing was saved.
    return new Response(JSON.stringify({
      error: 'You are offline — this was NOT saved. Please try again when the internet is back.',
      offline: true,
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}
