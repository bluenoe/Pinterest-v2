// Service Worker for Pinterest Gallery
// Network-first for app files (users always get the latest deploy when online),
// cache fallback when offline. Cross-origin assets (CDN) use cache-first.

const CACHE_NAME = 'pinterest-gallery-v3';
const APP_SHELL = [
    './',
    './index.html',
    './dist/styles.css',
    './script.js',
    './modules/StorageService.js',
    './modules/ImageProcessor.js',
    './modules/GalleryRenderer.js',
    './modules/LightboxController.js',
    './modules/VirtualGrid.js',
    './manifest.json'
];
const CDN_ASSETS = [
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// Install: cache each asset on its own, so one failed request (e.g. CDN down)
// does not leave the whole cache empty the way cache.addAll() would.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.allSettled(
                [...APP_SHELL, ...CDN_ASSETS].map((url) =>
                    cache.add(url).catch((error) => {
                        console.warn('SW: failed to cache', url, error);
                    })
                )
            )
        )
    );
    self.skipWaiting();
});

// Activate: remove caches from older versions
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetch(request);
        if (response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') {
            const shell = await cache.match('./index.html');
            if (shell) return shell;
        }
        throw error;
    }
}

async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
    }
    return response;
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    // Only handle GET over http(s); skip blob:, data:, chrome-extension:, etc.
    if (request.method !== 'GET' || !request.url.startsWith('http')) {
        return;
    }

    const isSameOrigin = new URL(request.url).origin === self.location.origin;
    event.respondWith(isSameOrigin ? networkFirst(request) : cacheFirst(request));
});
