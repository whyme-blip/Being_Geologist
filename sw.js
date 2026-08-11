const CACHE_NAME = 'geologger-app-v4'; // Bumped to v4 to clear v3 cache
const TILE_CACHE_NAME = 'geologger-osm-tiles-v1';

// Static assets required for the app shell to function offline
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './app.js',
  './icon-192.png',
  './icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
];

// Install Event: Pre-cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching static app shell & Leaflet resources');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting(); // Force activation immediately
});

// Activate Event: Clean up legacy caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== TILE_CACHE_NAME) {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim(); // Immediately control all open client windows
});

// Fetch Event: Cache management for App Shell & Map Tiles
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. STRATEGY FOR MAP TILES (Cache-First -> Network Fallback)
  // Essential for remote geological terrain with weak/intermittent cellular coverage
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then(async (cache) => {
        const cachedTile = await cache.match(event.request);
        if (cachedTile) {
          return cachedTile; // Return cached tile instantly
        }

        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse && networkResponse.ok) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          // If offline and not in cache, fail gracefully without breaking map render loop
          return new Response('', { status: 404, statusText: 'Tile Offline Unavailable' });
        }
      })
    );
    return;
  }

  // 2. STRATEGY FOR APP SHELL & ASSETS (Cache-First with Query Parameter Bypassing)
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      });
    })
  );
});
