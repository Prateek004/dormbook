/**
 * DormBook Service Worker — v2.1
 * Implements:
 *   - Cache-first for static assets
 *   - Network-first for API calls (with offline fallback)
 *   - Background Sync for offline payment/checkin mutations
 *
 * IMPORTANT: Bump CACHE_VERSION on every deploy that changes static files.
 */

const CACHE_VERSION   = 'dormbook-v4.0';
const STATIC_CACHE    = `${CACHE_VERSION}-static`;
const API_CACHE       = `${CACHE_VERSION}-api`;
const SYNC_QUEUE_KEY  = 'dormbook-sync-queue';

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
        keys.filter(k => k.startsWith('dormbook-') && k !== STATIC_CACHE && k !== API_CACHE)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: routing strategy ────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls: network-first with offline fallback queue
  if (url.pathname.startsWith('/api/v1')) {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(event.request.method)) {
      // Mutations: try network; if offline, queue for Background Sync
      event.respondWith(handleMutation(event.request));
    } else {
      // GETs: network-first
      event.respondWith(networkFirst(event.request, API_CACHE));
    }
    return;
  }

  // Static assets: cache-first
  event.respondWith(cacheFirst(event.request, STATIC_CACHE));
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — resource not cached', { status: 503 });
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response(JSON.stringify({ error: 'Offline', offline: true }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleMutation(request) {
  try {
    return await fetch(request);
  } catch {
    // Do NOT queue money/check-in writes offline. The old queue lived only in
    // service-worker memory (lost whenever the browser stops the worker) and
    // replaying a request whose response was merely lost could record a payment
    // twice. Tell the user plainly that nothing was saved.
    return new Response(JSON.stringify({
      error: 'You are offline — this was NOT saved. Please try again when the internet is back.',
      offline: true,
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

// ── Background Sync: replay queued mutations ───────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'dormbook-offline-sync') {
    event.waitUntil(replayQueue());
  }
});

async function replayQueue() {
  const queue = await getQueue();
  if (!queue.length) return;

  const remaining = [];
  for (const item of queue) {
    try {
      const resp = await fetch(item.url, {
        method:  item.method,
        headers: item.headers,
        body:    item.method !== 'GET' ? item.body : undefined,
      });
      if (!resp.ok && resp.status < 500) {
        // Client error — discard (not retriable)
        console.warn('[SW] Discarding queued request (client error):', item.url);
      } else if (!resp.ok) {
        remaining.push(item); // server error — retry later
      }
    } catch {
      remaining.push(item); // still offline
    }
  }
  await saveQueue(remaining);

  // Notify all open clients
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'SYNC_COMPLETE', replayed: queue.length - remaining.length }));
}

// ── Simple IndexedDB-backed queue (falls back to memory) ──────────────────
let memQueue = [];
async function getQueue() { return memQueue; }
async function saveQueue(q) { memQueue = q; }
