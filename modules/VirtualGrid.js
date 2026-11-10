/**
 * VirtualGrid.js
 * Stable masonry layout + viewport windowing for the Pinterest-style grid.
 *
 * Responsibilities:
 *  - Masonry by "shortest column": each new card goes to the shortest column,
 *    so appending more photos NEVER moves cards that are already placed
 *    (CSS multi-column layouts re-balance everything and make the page jump).
 *  - Exact aspect-ratio placeholders: zero layout shift while images load.
 *  - Windowing with hysteresis: cards are hydrated ~1200px before they reach
 *    the viewport and released only when ~3000px away, so fast scrolling
 *    and scrolling back do not flash empty placeholders.
 *  - Images are shown only after they are fully decoded (img.decode()), then
 *    faded in over a tinted placeholder (average photo colour when known).
 *  - One delegated click/keyboard handler for the whole grid.
 */

import { formatFileSize } from './GalleryRenderer.js';
import { thumbnailWidthFor } from './ThumbnailService.js';

const MOUNT_MARGIN   = '1500px 0px 1500px 0px';
const UNMOUNT_MARGIN = '3500px 0px 3500px 0px';
const IDLE_LOOKAHEAD  = 90;  // cards ahead of the viewport to pre-generate when idle
const IDLE_LOOKBEHIND = 20;

/** Column count by viewport width (matches the previous CSS breakpoints). */
function columnCountFor(viewportWidth) {
    if (viewportWidth < 768)  return 2;
    if (viewportWidth < 1024) return 3;
    if (viewportWidth < 1280) return 4;
    if (viewportWidth < 1536) return 5;
    return 6;
}

function gapFor(viewportWidth) {
    return viewportWidth < 768 ? 8 : 16;
}

/** Stable pastel hue per image so placeholders are never plain grey. */
function hueFor(id) {
    const n = parseInt(String(id).slice(-6), 16);
    return Number.isFinite(n) ? n % 360 : 20;
}

export class VirtualGrid {
    /**
     * @param {object} options
     * @param {HTMLElement}      options.gridContainer
     * @param {ThumbnailService} options.thumbnails
     * @param {function(number): void}  options.onOpenLightbox   - (filteredIndex)
     * @param {function(number): void}  options.onStartSlideshow - (filteredIndex)
     * @param {function(string): void}  options.onToggleFavorite - (imageId)
     * @param {function(string): boolean} options.isFavorited
     * @param {function(string): number}  options.findIndex      - imageId -> filtered index
     */
    constructor(options) {
        this.grid             = options.gridContainer;
        this.thumbnails       = options.thumbnails;
        this.onOpenLightbox   = options.onOpenLightbox;
        this.onStartSlideshow = options.onStartSlideshow;
        this.onToggleFavorite = options.onToggleFavorite;
        this.isFavorited      = options.isFavorited;
        this.findIndex        = options.findIndex;

        this.items        = [];        // [{ image, el, wrapper, mounted, token }]
        this.elToItem     = new WeakMap();
        this.idToItem     = new Map();
        this.columns      = [];
        this.colHeights   = [];
        this.columnCount  = 0;
        this.gap          = 16;
        this.mountedCount = 0;
        this.slideshowActiveId = null;
        this._idleHandle = null;
        this._destroyed = false;

        this._initObservers();
        this._buildColumns();
        this._bindEvents();
    }

    // ---------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------

    _initObservers() {
        this.mountObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const item = this.elToItem.get(entry.target);
                if (item) this._mount(item);
            }
        }, { rootMargin: MOUNT_MARGIN });

        this.unmountObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting) continue;
                const item = this.elToItem.get(entry.target);
                if (item) this._unmount(item);
            }
        }, { rootMargin: UNMOUNT_MARGIN });
    }

    _bindEvents() {
        this._onClick = (e) => {
            const card = e.target.closest('.gallery-item');
            if (!card || !this.grid.contains(card)) return;
            const item = this.elToItem.get(card);
            if (!item) return;
            const id = item.image.id;

            if (e.target.closest('.favorite-btn')) {
                e.preventDefault();
                e.stopPropagation();
                this.onToggleFavorite(id);
                return;
            }
            const idx = this.findIndex(id);
            if (idx === -1) return;
            if (e.target.closest('.slideshow-btn')) {
                e.preventDefault();
                e.stopPropagation();
                this.onStartSlideshow(idx);
            } else {
                this.onOpenLightbox(idx);
            }
        };

        this._onKeyDown = (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const card = e.target.closest?.('.gallery-item');
            if (!card || e.target !== card) return;
            e.preventDefault();
            const item = this.elToItem.get(card);
            const idx = item ? this.findIndex(item.image.id) : -1;
            if (idx !== -1) this.onOpenLightbox(idx);
        };

        this._anchor = null;
        this._pendingRestore = false;
        this._restoreFrame = 0;
        this._scrollTimer = null;
        this._resizing = false;
        this._onScroll = () => {
            // Scroll events caused by the resize itself must not move the anchor
            if (this._resizing) return;
            clearTimeout(this._scrollTimer);
            this._scrollTimer = setTimeout(() => this._saveAnchor(), 120);
        };

        this._resizeTimer = null;
        this._onResize = () => {
            this._resizing = true;
            clearTimeout(this._scrollTimer);
            clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => this._handleResize(), 150);
        };

        this.grid.addEventListener('click', this._onClick);
        this.grid.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('resize', this._onResize);
        window.addEventListener('scroll', this._onScroll, { passive: true });
    }

    /** Remember which card is at the top of the screen (restored after re-layout). */
    _saveAnchor() {
        let best = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const item of this.items) {
            if (!item.mounted) continue; // only cards near the viewport
            const r = item.el.getBoundingClientRect();
            if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
            const dist = Math.abs(r.top);
            if (dist < bestDist) {
                bestDist = dist;
                best = { id: item.image.id, top: r.top };
            }
        }
        this._anchor = best;
    }

    _restoreAnchor() {
        const item = this._anchor && this.idToItem.get(this._anchor.id);
        this._pendingRestore = false;
        if (!item) return;
        const delta = item.el.getBoundingClientRect().top - this._anchor.top;
        if (Math.abs(delta) <= 1) return;
        window.scrollBy(0, delta);
        // Page too short to reach the card yet (e.g. more columns → shorter
        // page): try again once more cards have been appended.
        const remaining = item.el.getBoundingClientRect().top - this._anchor.top;
        if (Math.abs(remaining) > 1) this._pendingRestore = true;
    }

    _buildColumns() {
        const vw = window.innerWidth;
        this.columnCount = columnCountFor(vw);
        this.gap = gapFor(vw);
        this.grid.style.setProperty('--grid-gap', `${this.gap}px`);

        this.grid.innerHTML = '';
        this.columns = [];
        this.colHeights = [];
        for (let i = 0; i < this.columnCount; i++) {
            const col = document.createElement('div');
            col.className = 'masonry-col';
            this.grid.appendChild(col);
            this.columns.push(col);
            this.colHeights.push(0);
        }
    }

    _columnWidth() {
        const total = this.grid.clientWidth || window.innerWidth;
        return Math.max(1, (total - this.gap * (this.columnCount - 1)) / this.columnCount);
    }

    _place(item) {
        let target = 0;
        for (let i = 1; i < this.colHeights.length; i++) {
            if (this.colHeights[i] < this.colHeights[target] - 0.5) target = i;
        }
        this.columns[target].appendChild(item.el);
        const { width, height } = item.image;
        this.colHeights[target] += this._columnWidth() * (height / width) + this.gap;
    }

    // ---------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------

    /**
     * Append a placeholder card for an image. Heavy content is added later,
     * when the card gets near the viewport.
     * @param {object} image - Image record from ImageProcessor.
     * @returns {HTMLElement}
     */
    appendItem(image) {
        const el = document.createElement('div');
        el.className = 'gallery-item';
        el.dataset.imageId = image.id;
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', image.name);

        const wrapper = document.createElement('div');
        wrapper.className = 'image-wrapper';
        wrapper.style.aspectRatio = `${image.width} / ${image.height}`;
        wrapper.style.setProperty('--ph-h', hueFor(image.id));
        const knownColor = this.thumbnails.getColor(image.id);
        if (knownColor) {
            wrapper.style.setProperty('--ph-color', knownColor);
            wrapper.dataset.color = '1';
        }
        el.appendChild(wrapper);

        const item = { image, el, wrapper, mounted: false, token: 0, index: this.items.length };
        this.items.push(item);
        this.elToItem.set(el, item);
        this.idToItem.set(image.id, item);
        if (image.id === this.slideshowActiveId) el.classList.add('slideshow-active');

        this._place(item);
        this.mountObserver.observe(el);
        this.unmountObserver.observe(el);

        if (this._pendingRestore && !this._restoreFrame) {
            this._restoreFrame = requestAnimationFrame(() => {
                this._restoreFrame = 0;
                this._resizing = true;
                this._restoreAnchor();
                requestAnimationFrame(() => requestAnimationFrame(() => { this._resizing = false; }));
            });
        }
        return el;
    }

    updateFavorite(imageId, isFav) {
        const item = this.idToItem.get(imageId);
        if (!item || !item.mounted) return;
        const favBtn = item.el.querySelector('.favorite-btn');
        if (!favBtn) return;
        favBtn.classList.toggle('favorited', isFav);
        favBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
        favBtn.setAttribute('aria-pressed', String(isFav));
        favBtn.innerHTML = `<i class="${isFav ? 'fas' : 'far'} fa-heart"></i>`;
    }

    /** Highlight the card that the slideshow is currently showing. */
    setSlideshowActive(activeImageId) {
        if (this.slideshowActiveId === activeImageId) return;
        if (this.slideshowActiveId) {
            this.idToItem.get(this.slideshowActiveId)?.el.classList.remove('slideshow-active');
        }
        this.slideshowActiveId = activeImageId || null;
        if (this.slideshowActiveId) {
            this.idToItem.get(this.slideshowActiveId)?.el.classList.add('slideshow-active');
        }
    }

    /** Remove all cards (keeps cached thumbnails for instant re-display). */
    reset() {
        this.mountObserver.disconnect();
        this.unmountObserver.disconnect();
        this._cancelIdle();
        this.thumbnails.cancelAll();
        this.thumbnails.unpinAll();
        for (const item of this.items) {
            item.mounted = false;
            item.token++;
        }
        this.items = [];
        this.idToItem.clear();
        this.elToItem = new WeakMap();
        this._anchor = null;
        this._pendingRestore = false;
        this.mountedCount = 0;
        this._buildColumns();
    }

    destroy() {
        this._destroyed = true;
        this._cancelIdle();
        this.reset();
        this.mountObserver.disconnect();
        this.unmountObserver.disconnect();
        this.grid.removeEventListener('click', this._onClick);
        this.grid.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('resize', this._onResize);
        window.removeEventListener('scroll', this._onScroll);
        clearTimeout(this._resizeTimer);
        clearTimeout(this._scrollTimer);
    }

    getStats() {
        const total = this.items.length;
        return {
            total,
            mounted: this.mountedCount,
            virtualized: Math.max(0, total - this.mountedCount)
        };
    }

    // ---------------------------------------------------------------------
    // Resize: re-flow columns while keeping the user's place on the page
    // ---------------------------------------------------------------------

    _handleResize() {
        const vw = window.innerWidth;
        if (columnCountFor(vw) === this.columnCount && gapFor(vw) === this.gap) {
            // Same column count: cards only scale, recompute running heights
            this._recomputeHeights();
        } else {
            this._buildColumnsKeepingItems();
        }
        // Put the card the user was looking at back where it was
        this._restoreAnchor();
        // Ignore the scroll event our own correction triggers
        requestAnimationFrame(() => requestAnimationFrame(() => { this._resizing = false; }));
    }

    _buildColumnsKeepingItems() {
        const items = this.items;
        this._buildColumns();
        for (const item of items) this._place(item);
    }

    _recomputeHeights() {
        const w = this._columnWidth();
        this.colHeights = this.columns.map(col => {
            let h = 0;
            for (const el of col.children) {
                const item = this.elToItem.get(el);
                if (item) h += w * (item.image.height / item.image.width) + this.gap;
            }
            return h;
        });
    }

    // ---------------------------------------------------------------------
    // Hydration
    // ---------------------------------------------------------------------

    _mount(item) {
        if (item.mounted) return;
        item.mounted = true;
        const token = ++item.token;
        this.mountedCount++;

        const { image, el, wrapper } = item;
        this.thumbnails.pin(image.id);

        // Overlay (title + meta) — user text via textContent only
        const overlay = document.createElement('div');
        overlay.className = 'gallery-item-overlay';
        const info = document.createElement('div');
        info.className = 'gallery-item-info';
        const title = document.createElement('div');
        title.className = 'gallery-item-title';
        title.textContent = image.name;
        const meta = document.createElement('div');
        meta.className = 'gallery-item-meta';
        meta.textContent = `${formatFileSize(image.size)} • ${image.width}×${image.height}`;
        info.append(title, meta);
        overlay.appendChild(info);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'gallery-item-actions';
        const isFav = this.isFavorited(image.id);
        actions.innerHTML = `
            <button type="button" class="gallery-action-btn slideshow-btn" title="Start slideshow from here" aria-label="Start slideshow from here">
                <i class="fas fa-play"></i>
            </button>
            <button type="button" class="gallery-action-btn favorite-btn ${isFav ? 'favorited' : ''}"
                    title="${isFav ? 'Remove from favorites' : 'Add to favorites'}"
                    aria-label="Favorite" aria-pressed="${isFav}">
                <i class="${isFav ? 'fas' : 'far'} fa-heart"></i>
            </button>`;

        el.append(overlay, actions);
        el.classList.add('mounted');

        const cached = this.thumbnails.getCached(image.id);
        if (cached) {
            this._showImage(item, cached, token, false);
        } else {
            wrapper.classList.add('is-loading');
            const width = thumbnailWidthFor(this._columnWidth());
            this.thumbnails.request(image, width, el).then(url => {
                if (url && item.mounted && item.token === token) {
                    this._showImage(item, url, token, true);
                }
                this._scheduleIdlePrefetch();
            });
        }
        this._scheduleIdlePrefetch();
    }

    // ---------------------------------------------------------------------
    // Background pre-generation: when nothing urgent is queued, prepare
    // thumbnails for the cards just beyond the hydrated area so that even
    // fast scrolling finds them ready.
    // ---------------------------------------------------------------------

    _cancelIdle() {
        if (this._idleHandle === null) return;
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(this._idleHandle);
        clearTimeout(this._idleHandle);
        this._idleHandle = null;
    }

    _scheduleIdlePrefetch() {
        if (this._idleHandle !== null || this._destroyed) return;
        const run = () => {
            this._idleHandle = null;
            this._idlePrefetch();
        };
        this._idleHandle = typeof requestIdleCallback === 'function'
            ? requestIdleCallback(run, { timeout: 500 })
            : setTimeout(run, 120);
    }

    _idlePrefetch() {
        if (this._destroyed || this.items.length === 0) return;
        if (!this.thumbnails.isIdle()) {
            this._scheduleIdlePrefetch();
            return;
        }

        // Range of hydrated cards (append order ≈ top-to-bottom order)
        let first = -1;
        let last = -1;
        for (const item of this.items) {
            if (!item.mounted) continue;
            if (first === -1) first = item.index;
            last = item.index;
        }
        if (last === -1) return;

        const width = thumbnailWidthFor(this._columnWidth());
        const slots = this.thumbnails.concurrency - this.thumbnails.inFlight;
        let started = 0;
        const consider = (i) => {
            const item = this.items[i];
            if (!item || this.thumbnails.has(item.image.id)) return false;
            this.thumbnails.request(item.image, width).then(() => this._scheduleIdlePrefetch());
            started++;
            return started >= slots;
        };

        const end = Math.min(this.items.length - 1, last + IDLE_LOOKAHEAD);
        for (let i = last + 1; i <= end; i++) if (consider(i)) return;
        const start = Math.max(0, first - IDLE_LOOKBEHIND);
        for (let i = first - 1; i >= start; i--) if (consider(i)) return;
    }

    _showImage(item, url, token, animate) {
        const { image, wrapper } = item;
        const img = new Image();
        img.className = 'lazy-image';
        img.alt = image.name;
        img.decoding = 'async';
        img.draggable = false;
        img.src = url;

        const reveal = (ok) => {
            if (!item.mounted || item.token !== token) return;
            wrapper.classList.remove('is-loading');

            const color = this.thumbnails.getColor(image.id);
            if (color && !wrapper.dataset.color) {
                wrapper.style.setProperty('--ph-color', color);
                wrapper.dataset.color = '1';
            }

            if (!ok) {
                wrapper.classList.add('is-broken');
                return;
            }
            wrapper.appendChild(img);
            wrapper.classList.add('loaded');
            if (animate) {
                // Next frame so the opacity transition actually runs
                requestAnimationFrame(() => img.classList.add('lazy-loaded'));
            } else {
                img.classList.add('lazy-loaded', 'no-fade');
            }
        };

        // Only insert once fully decoded: never shows a half-painted image
        img.decode().then(() => reveal(true), () => {
            // decode() can reject for valid images in some browsers; fall back to load state
            if (img.complete && img.naturalWidth > 0) reveal(true);
            else {
                img.onload = () => reveal(true);
                img.onerror = () => reveal(false);
            }
        });
    }

    _unmount(item) {
        if (!item.mounted) return;
        item.mounted = false;
        item.token++;
        this.mountedCount--;

        const { image, el, wrapper } = item;
        this.thumbnails.cancel(image.id);
        this.thumbnails.unpin(image.id);

        el.querySelector('.gallery-item-overlay')?.remove();
        el.querySelector('.gallery-item-actions')?.remove();
        el.classList.remove('mounted');
        wrapper.replaceChildren();
        wrapper.classList.remove('loaded', 'is-loading', 'is-broken');
    }
}
