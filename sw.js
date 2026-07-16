const CACHE_NAME = 'geologger-v1';

// The essential files to cache immediately upon installation
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// 1. INSTALL EVENT: Cache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching V1 assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  // We do NOT use self.skipWaiting() here so that the existing 
  // confirmation prompt in your index.html functions correctly.
});

// 2. ACTIVATE EVENT: Clean up old caches if you ever change CACHE_NAME
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
  return self.clients.claim(); // Take immediate control of the page
});

// 3. FETCH EVENT: Network-First Strategy (Cache Fallback)
self.addEventListener('fetch', (event) => {
  // Only handle GET requests (ignore POST, PUT, etc.)
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // We are ONLINE. The fetch succeeded.
        // Clone the response and update the cache with the freshest version
        return caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, networkResponse.clone());
          return networkResponse;
        });
      })
      .catch(() => {
        // We are OFFLINE. The fetch failed.
        // Fall back to the cached version.
        console.log('[Service Worker] Offline mode: Serving from cache ->', event.request.url);
        return caches.match(event.request);
      })
  );
});
