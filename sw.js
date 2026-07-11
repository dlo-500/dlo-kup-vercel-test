// DLO Kupwara — Service Worker v2.0 (offline-capable)
const STATIC_CACHE = 'dlo-kupwara-static-v2';
const DATA_CACHE   = 'dlo-kupwara-data-v2';

const STATIC_ASSETS = [
  '/dlo-kupwaraa/',
  '/dlo-kupwaraa/index.html',
  '/dlo-kupwaraa/logo.png',
  '/dlo-kupwaraa/manifest.json',
  '/dlo-kupwaraa/offline.html',
];

// ═══════════════════════════════════════════════
//  INSTALL — precache the app shell + offline page
// ═══════════════════════════════════════════════
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

// ═══════════════════════════════════════════════
//  ACTIVATE — drop old cache versions
// ═══════════════════════════════════════════════
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== DATA_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Lets the page tell a waiting worker to activate immediately (used for the
// "update available — tap to refresh" prompt on the front end).
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// Every Google Sheets ("gviz") request appends a random cache-busting query
// string (&rand=...&t=...), so the raw request URL is never the same twice.
// To actually cache this data we key it by the *sheet name* instead, so
// repeat requests for the same sheet hit the same cache entry.
function sheetCacheKey(url) {
  const sheet = url.searchParams.get('sheet') || 'default';
  return new Request(self.location.origin + '/__sheet-cache__/' + encodeURIComponent(sheet));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Analytics — best-effort only, never cache, never block on it.
  if (url.hostname.includes('cloudflareinsights.com')) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 204 })));
    return;
  }

  // Google Sheets case/history/performance/updates data — network-first,
  // cache successful responses under a normalized key, and serve the last
  // good copy (flagged as stale) when offline.
  if (url.hostname === 'docs.google.com' && url.pathname.includes('/gviz/tq')) {
    const cacheKey = sheetCacheKey(url);
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(DATA_CACHE).then(cache => cache.put(cacheKey, clone));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(cacheKey);
          if (cached) {
            const body = await cached.text();
            return new Response(body, {
              status: 200,
              headers: { 'Content-Type': 'application/json', 'X-DLO-Offline': '1' }
            });
          }
          return new Response('Offline', { status: 503 });
        })
    );
    return;
  }

  // Apps Script calls (AI assistant, form submissions) — these are live
  // actions, not cacheable data. Just try the network and fail clearly.
  if (url.hostname === 'script.google.com') {
    event.respondWith(fetch(req).catch(() => new Response('Offline', { status: 503 })));
    return;
  }

  // Page navigations — network-first, fall back to the cached shell, then
  // to a friendly offline page if nothing is cached yet.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(req, clone));
          return res;
        })
        .catch(() =>
          caches.match(req)
            .then(cached => cached || caches.match('/dlo-kupwaraa/index.html'))
            .then(cached => cached || caches.match('/dlo-kupwaraa/offline.html'))
        )
    );
    return;
  }

  // Supabase (or any) POST/PUT/PATCH/DELETE calls — logins, inserts, updates.
  // The Cache API only supports GET, so never attempt to cache these;
  // just pass them straight through to the network.
  if (req.method !== 'GET') {
    event.respondWith(fetch(req));
    return;
  }

  // Everything else (CSS/JS/images/fonts/same-origin GET assets) —
  // network-first with a cache fallback, keeping the cache warm for offline use.
  event.respondWith(
    fetch(req)
      .then(res => {
        const clone = res.clone();
        caches.open(STATIC_CACHE).then(cache => cache.put(req, clone));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
