// Service Worker for Pinterest Gallery
// Pure Offline-First Caching Engine (Phase P2)

const CACHE_NAME = 'pinterest-gallery-v2';
const urlsToCache = [
    './',
    './index.html',
    './dist/styles.css',
    './script.js',
    './modules/StorageService.js',
    './modules/ImageProcessor.js',
    './modules/GalleryRenderer.js',
    './modules/LightboxController.js',
    './modules/VirtualGrid.js',
    './manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// Install event - cache all local application assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                return cache.addAll(urlsToCache);
            })
            .catch((error) => {
                console.warn('SW cache installation warning:', error);
            })
    );
    self.skipWaiting();
});

// Fetch event - cache-first strategy with network fallback
self.addEventListener('fetch', (event) => {
    // Only handle GET requests and skip non-http(s) schemes (e.g. blob:)
    if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                if (cachedResponse) {
                    return cachedResponse;
                }
                return fetch(event.request).catch(() => {
                    if (event.request.destination === 'document') {
                        return caches.match('./index.html');
                    }
                });
            })
    );
});

// Activate event - clean up old caches immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});