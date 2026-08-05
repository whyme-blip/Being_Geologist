const CACHE_NAME = 'geologger-app-v3'; // Bumped to v3 to trigger immediate cache update for app.js
const TILE_CACHE_NAME = 'geologger-osm-tiles-v1';

// Static assets required for the app to function offline
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './app.js',                                         // Application logic & HighPrecisionGPS engine
  './icon-192.png',                                  // App home screen icon (192px)
  './icon-512.png',                                  // App home screen icon (512px)
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', // Map styling
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',  // Map engine
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',   // Default map pin icon
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'  // Map pin shadow
];

// Install Event: Cache app shell and Leaflet dependencies
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching static app shell & Leaflet resources');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting(); // Forces active status immediately on install
});

// Activate Event: Clean up outdated caches (v2 and older caches will be automatically deleted)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== TILE_CACHE_NAME) {
            console.log('[SW] Removing old cache layer:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim(); // Takes control of open tabs immediately
});

// Fetch Event: Network-first for map tiles, Cache-first for core app files
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Strategy for OpenStreetMap Tiles: Network-first, fallback to offline tile cache
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open(TILE_CACHE_NAME).then(async (cache) => {
        try {
          const response = await fetch(event.request);
          if (response.ok) {
            cache.put(event.request, response.clone());
          }
          return response;
        } catch (err) {
          // If offline, retrieve cached map tile if available
          const cachedTile = await cache.match(event.request);
          if (cachedTile) return cachedTile;
          throw err;
        }
      })
    );
    return;
  }

  // Strategy for App Shell & CDN resources: Cache-first, then Network
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
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
