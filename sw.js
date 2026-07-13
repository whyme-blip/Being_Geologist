const CACHE_NAME = 'aven-geologger-v2';

// 1. Added your manifest icons so PWA installation passes device validation
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
  // Note: Remember to add your local .js or .css files here when you create them!
];

// Install Service Worker and cache essential UI components
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Aven GeoLogger: Localizing assets for offline use...');
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate worker and clean up legacy cache builds
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('Aven GeoLogger: Purging old cache system:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 2. Cache-First Strategy: Critical for reliable remote fieldwork
self.addEventListener('fetch', (event) => {
  // Ignore external browser extensions or analytical tracking URLs
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // If the file is cached, serve it instantly. No network lag.
      if (cachedResponse) {
        return cachedResponse;
      }

      // If it's a new asset, grab it from the network and save a copy for next time
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      });
    })
  );
});
