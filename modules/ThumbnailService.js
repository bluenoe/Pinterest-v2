/**
 * ThumbnailService.js
 * Produces small, grid-sized thumbnails so the gallery never decodes
 * full-resolution photos while scrolling.
 *
 * Why: a 4000×3000 photo costs ~48 MB of decoded memory. Showing dozens of
 * them at once makes scrolling stutter and can crash mobile browsers.
 * A 480px-wide thumbnail costs ~0.6 MB and decodes almost instantly.
 *
 * Responsibilities:
 *  - Reuse thumbnails saved on disk by earlier visits (IndexedDB).
 *  - Queue thumbnail jobs, always serving the item closest to the viewport first.
 *  - Generate thumbnails in a Web Worker (off the main thread).
 *  - Remember each image's average colour for placeholders.
 *  - LRU cache with a size cap; images currently on screen are never evicted.
 *  - Fall back to the original file when thumbnails are not possible
 *    (no Worker/OffscreenCanvas support, SVG, animated GIF, small images).
 */

import { withStore, isIndexedDBAvailable } from './LocalDB.js';

const WORKER_URL = new URL('./ThumbnailWorker.js', import.meta.url);

// Thumbnails kept on disk between visits (~40 KB each → ~200 MB at most)
const PERSIST_MAX = 5000;

/** Identifies the exact file a stored thumbnail was made from. */
function fingerprint(image) {
    return `${image.name}|${image.size}|${image.lastModified}|${image.path}`;
}

/**
 * On-disk thumbnail cache (IndexedDB). A record is only used when its
 * fingerprint matches, so an edited or different file never shows a stale
 * thumbnail.
 */
const thumbStore = {
    async get(key, fp) {
        const rec = await withStore('thumbs', 'readonly', (store, p) => p(store.get(key)));
        return rec && rec.fp === fp && rec.blob ? rec : null;
    },
    put(key, record) {
        return withStore('thumbs', 'readwrite', store => {
            store.put({ key, ...record, t: Date.now() });
        });
    },
    async prune(max) {
        const count = await withStore('thumbs', 'readonly', (store, p) => p(store.count()));
        if (count <= max) return;
        let toDelete = count - Math.floor(max * 0.9);
        await withStore('thumbs', 'readwrite', store => new Promise(resolve => {
            const req = store.index('t').openCursor(); // oldest first
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor || toDelete <= 0) return resolve();
                cursor.delete();
                toDelete--;
                cursor.continue();
            };
            req.onerror = () => resolve();
        }));
    }
};

const CAN_USE_WORKER =
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap === 'function';

/** Round the requested width up to a few fixed sizes so cache hits stay high. */
export function thumbnailWidthFor(columnWidth) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.max(1, columnWidth) * dpr;
    const buckets = [240, 360, 480, 640, 800];
    return buckets.find(b => b >= px) || buckets[buckets.length - 1];
}

export class ThumbnailService {
    /**
     * @param {object} [options]
     * @param {number} [options.maxEntries]  - Max thumbnails kept (~40 KB each).
     * @param {number} [options.workers]     - Worker threads decoding in parallel.
     */
    constructor({ maxEntries, workers } = {}) {
        const cores = navigator.hardwareConcurrency || 4;
        const lowMemory = (navigator.deviceMemory || 8) <= 4;
        this.maxEntries  = maxEntries || (lowMemory ? 600 : 1500);
        this.workerCount = workers || Math.max(1, Math.min(3, cores - 2));
        this.concurrency = this.workerCount * 2;

        this.cache   = new Map(); // id -> object URL (Map order = LRU order)
        this.colors  = new Map(); // id -> 'rgb(r, g, b)'
        this.pinned  = new Map(); // id -> pin count (on-screen items)
        this.jobs    = new Map(); // id -> job (queued or in flight)
        this.queue   = [];        // queued jobs (not yet sent)
        this.inFlight = 0;

        this.workers = [];
        this.workerLoad = [];
        this.workerFailed = !CAN_USE_WORKER;

        this.persistEnabled = isIndexedDBAvailable();
        this.persistentHits = 0;
        this.generated = 0;
        // Housekeeping once things have settled
        setTimeout(() => {
            if (this.persistEnabled) thumbStore.prune(PERSIST_MAX).catch(() => {});
        }, 10000);
    }

    // ---------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------

    /** Cached thumbnail URL (marks it as recently used), or null. */
    getCached(id) {
        const url = this.cache.get(id);
        if (url === undefined) return null;
        this.cache.delete(id);
        this.cache.set(id, url);
        return url;
    }

    /** Average colour of a thumbnail generated earlier, or null. */
    getColor(id) {
        return this.colors.get(id) || null;
    }

    /**
     * Ask for a thumbnail. Resolves with an object URL, or null when the job
     * was cancelled. Duplicate requests share one job.
     *
     * @param {object}      image    - Image record ({ id, file, width, height, type, size, name }).
     * @param {number}      width    - Target pixel width.
     * @param {HTMLElement} [element] - Grid card; used to prioritise by distance to the viewport.
     * @returns {Promise<string|null>}
     */
    request(image, width, element) {
        const cached = this.getCached(image.id);
        if (cached) return Promise.resolve(cached);

        const existing = this.jobs.get(image.id);
        if (existing) {
            existing.element = element || existing.element;
            return existing.promise;
        }

        const job = { image, width, element, sent: false };
        job.promise = new Promise(resolve => { job.resolve = resolve; });
        this.jobs.set(image.id, job);

        if (this.persistEnabled && this._needsThumbnail(image, width)) {
            this._lookupPersistent(job); // disk first, worker only on a miss
        } else {
            this.queue.push(job);
            this._pump();
        }
        return job.promise;
    }

    /** Drop a job that has not started yet (e.g. the card scrolled far away). */
    cancel(id) {
        const job = this.jobs.get(id);
        if (!job || job.sent) return;
        this.jobs.delete(id);
        const i = this.queue.indexOf(job);
        if (i !== -1) this.queue.splice(i, 1);
        job.resolve(null);
    }

    /** Drop every job that has not started yet. */
    cancelAll() {
        for (const job of this.queue) {
            this.jobs.delete(job.image.id);
            job.resolve(null);
        }
        this.queue = [];
    }

    /** Protect a thumbnail from eviction while its card is on screen. */
    pin(id) {
        this.pinned.set(id, (this.pinned.get(id) || 0) + 1);
    }

    unpin(id) {
        const n = (this.pinned.get(id) || 0) - 1;
        if (n > 0) this.pinned.set(id, n);
        else this.pinned.delete(id);
    }

    unpinAll() {
        this.pinned.clear();
        this._evict();
    }

    /** Release everything (call when a new set of folders is loaded). */
    clear() {
        this.cancelAll();
        this.cache.forEach(url => URL.revokeObjectURL(url));
        this.cache.clear();
        this.colors.clear();
        this.pinned.clear();
    }

    destroy() {
        this.clear();
        this.workers.forEach(w => w.terminate());
        this.workers = [];
        this.workerLoad = [];
    }

    /** True when nothing urgent is waiting (used for background pre-generation). */
    isIdle() {
        return this.queue.length === 0 && this.inFlight < this.concurrency;
    }

    /** True when a thumbnail exists or is already being prepared. */
    has(id) {
        return this.cache.has(id) || this.jobs.has(id);
    }

    getStats() {
        return {
            cachedThumbnails: this.cache.size,
            queued: this.queue.length,
            inFlight: this.inFlight,
            thumbnailsFromDisk: this.persistentHits,
            thumbnailsGenerated: this.generated
        };
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /** Least-busy worker from the pool (created on first use). */
    _getWorker() {
        if (this.workerFailed) return null;
        try {
            while (this.workers.length < this.workerCount) {
                const index = this.workers.length;
                const worker = new Worker(WORKER_URL);
                worker.onmessage = (e) => {
                    this.workerLoad[index] = Math.max(0, this.workerLoad[index] - 1);
                    this._onWorkerMessage(e.data);
                };
                worker.onerror = () => this._disableWorkers();
                this.workers.push(worker);
                this.workerLoad.push(0);
            }
        } catch {
            this._disableWorkers();
            return null;
        }
        let best = 0;
        for (let i = 1; i < this.workers.length; i++) {
            if (this.workerLoad[i] < this.workerLoad[best]) best = i;
        }
        this.workerLoad[best]++;
        return this.workers[best];
    }

    /** Workers unavailable: finish everything with the original files. */
    _disableWorkers() {
        if (this.workerFailed) return;
        this.workerFailed = true;
        this.workers.forEach(w => w.terminate());
        this.workers = [];
        this.workerLoad = [];
        this.inFlight = 0;
        for (const job of [...this.jobs.values()]) {
            if (job.sent) this._finishWithOriginal(job);
        }
        this._pump();
    }

    /** Distance in px from the element to the viewport (0 = on screen). */
    _distance(job) {
        const el = job.element;
        if (!el || !el.isConnected) return Number.POSITIVE_INFINITY;
        const r = el.getBoundingClientRect();
        if (r.bottom < 0) return -r.bottom;
        if (r.top > window.innerHeight) return r.top - window.innerHeight;
        return 0;
    }

    _nextJob() {
        let best = -1;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = 0; i < this.queue.length; i++) {
            const d = this._distance(this.queue[i]);
            if (d < bestDist) {
                bestDist = d;
                best = i;
                if (d === 0) break;
            }
        }
        if (best === -1) best = 0;
        return this.queue.splice(best, 1)[0];
    }

    _lookupPersistent(job) {
        const { image, width } = job;
        const enqueue = () => {
            if (this.jobs.get(image.id) !== job) return; // cancelled meanwhile
            this.queue.push(job);
            this._pump();
        };
        thumbStore.get(`${image.id}:${width}`, fingerprint(image)).then(rec => {
            if (this.jobs.get(image.id) !== job) return;
            if (!rec) return enqueue();
            if (rec.color) {
                const [r, g, b] = rec.color;
                this.colors.set(image.id, `rgb(${r}, ${g}, ${b})`);
            }
            this.persistentHits++;
            this._finish(job, URL.createObjectURL(rec.blob));
        }, () => {
            this.persistEnabled = false; // storage unavailable (e.g. private mode)
            enqueue();
        });
    }

    _needsThumbnail(image, width) {
        const type = (image.type || '').toLowerCase();
        const name = (image.name || '').toLowerCase();
        if (type === 'image/svg+xml' || name.endsWith('.svg')) return false;
        if (type === 'image/gif' || name.endsWith('.gif')) return false; // keep animation
        // Already small: decoding the original is cheap
        if (image.width <= width * 1.5 && image.size < 1.5 * 1024 * 1024) return false;
        return true;
    }

    _pump() {
        while (this.inFlight < this.concurrency && this.queue.length > 0) {
            const job = this._nextJob();
            const { image, width } = job;

            const worker = this._needsThumbnail(image, width) ? this._getWorker() : null;
            if (!worker) {
                this._finishWithOriginal(job);
                continue;
            }

            job.sent = true;
            this.inFlight++;
            const type = (image.type || '').toLowerCase();
            const keepAlpha = !(type === 'image/jpeg' || /\.jpe?g$/i.test(image.name));
            worker.postMessage({ id: image.id, file: image.file, width, keepAlpha });
        }
    }

    _onWorkerMessage(data) {
        const job = this.jobs.get(data.id);
        if (!job) return;
        this.inFlight = Math.max(0, this.inFlight - 1);

        if (data.error || !data.blob) {
            this._finishWithOriginal(job);
        } else {
            // Guard: if the thumbnail's orientation differs from the measured
            // one (browser ignored EXIF rotation), use the original instead.
            const expected = job.image.width / job.image.height;
            const actual = data.width / data.height;
            if (Math.abs(actual - expected) / expected > 0.03) {
                this._finishWithOriginal(job);
            } else {
                if (data.color) {
                    const [r, g, b] = data.color;
                    this.colors.set(data.id, `rgb(${r}, ${g}, ${b})`);
                }
                this.generated++;
                if (this.persistEnabled) {
                    thumbStore.put(`${job.image.id}:${job.width}`, {
                        fp: fingerprint(job.image),
                        blob: data.blob,
                        color: data.color,
                        width: data.width,
                        height: data.height
                    }).catch(() => { this.persistEnabled = false; });
                }
                this._finish(job, URL.createObjectURL(data.blob));
            }
        }
        this._pump();
    }

    _finishWithOriginal(job) {
        if (job.sent) {
            job.sent = false;
        }
        this._finish(job, URL.createObjectURL(job.image.file));
    }

    _finish(job, url) {
        this.jobs.delete(job.image.id);
        this.cache.set(job.image.id, url);
        this._evict();
        job.resolve(url);
    }

    _evict() {
        if (this.cache.size <= this.maxEntries) return;
        for (const [id, url] of this.cache) {
            if (this.cache.size <= this.maxEntries) break;
            if (this.pinned.has(id)) continue;
            URL.revokeObjectURL(url);
            this.cache.delete(id);
        }
    }
}
