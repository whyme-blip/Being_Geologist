const CACHE_NAME = 'geologger-v3'; // Incremented version to force an update

const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Install stage - caching everything needed for offline use
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

// NEW: Activate stage - deletes old caches (e.g., geologger-v2) so your new code shows up instantly
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Clearing old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

// Fetch stage - serving cached assets offline
self.addEventListener('fetch', event => {
  event.waitUntil(
    // Workaround to prevent chrome extension fetch errors crashing the worker
    if (event.request.url.startsWith('chrome-extension://') || event.request.url.includes('extension')) return;
  );

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        return response || fetch(event.request);
      })
  );
});
