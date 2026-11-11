// Service Worker for Pinterest Gallery
// Network-first for app files (users always get the latest deploy when online),
// cache fallback when offline. Cross-origin assets (CDN) use cache-first.

const CACHE_NAME = 'pinterest-gallery-v7';
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
    './modules/ThumbnailService.js',
    './modules/ThumbnailWorker.js',
    './modules/icons.js',
    './modules/LocalDB.js',
    './modules/FolderStore.js',
    './manifest.json'
];
const CDN_ASSETS = [
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap'
];

// Install: cache each asset on its own, so one failed request (e.g. CDN down)
// does not leave the whole cache empty the way cache.addAll() would.
// 'reload' skips the HTTP cache so the offline copy is the current file.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.allSettled(
                [...APP_SHELL, ...CDN_ASSETS].map((url) =>
                    cache.add(new Request(url, { cache: 'reload' })).catch((error) => {
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
        // 'no-cache' makes the browser check with the server every time.
        // A plain fetch() may reuse an HTTP-cached copy that it guesses is
        // still fresh (servers often send Last-Modified but no Cache-Control),
        // which serves an old index.html or styles.css after an update.
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        // Exact URL first: with ignoreSearch alone, an older "?v=…" copy
        // stored earlier would win over the current one
        const cached = await cache.match(request) ||
            await cache.match(request, { ignoreSearch: true });
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
