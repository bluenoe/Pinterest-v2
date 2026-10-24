/**
 * VirtualGrid.js
 * Viewport-aware DOM windowing and recycling engine for Pinterest-style masonry grid.
 *
 * Responsibilities:
 *  - Maintains masonry grid structure and scroll height with zero CLS (Cumulative Layout Shift)
 *    by preserving precise aspect-ratio placeholder geometry for all items.
 *  - Viewport-aware windowing: mounts heavy DOM nodes (<img>, overlay, action buttons, listeners)
 *    only for items inside the viewport + configurable buffer threshold (e.g. 1000px).
 *  - Virtualization / Demounting: unmounts heavy DOM nodes and immediately triggers
 *    blob URL revocation for off-screen items far outside the buffer.
 *  - On-demand hydration: re-allocates blob URLs and mounts DOM nodes when scrolling back into buffer.
 *  - Protects active Lightbox image from premature blob URL revocation.
 *  - Provides telemetry and performance metrics (mounted vs virtualized counts).
 */

import { escapeHtml, formatFileSize } from './GalleryRenderer.js';

export class VirtualGrid {
    /**
     * @param {object} options
     * @param {HTMLElement} options.gridContainer - The .masonry-grid DOM element.
     * @param {function(string): (string|null)} options.getBlobUrl - imageId -> blobUrl
     * @param {function(string): void} options.revokeBlobUrl - imageId -> void
     * @param {function(number): void} options.onOpenLightbox - (filteredIndex) -> void
     * @param {function(number): void} options.onStartSlideshow - (filteredIndex) -> void
     * @param {function(string): void} options.onToggleFavorite - (imageId) -> void
     * @param {function(string): boolean} options.isFavorited - (imageId) -> boolean
     * @param {function(string): number} options.findIndex - (imageId) -> index in filteredImages
     * @param {function(): (string|null)} [options.getActiveLightboxImageId] - returns currently open image ID in lightbox
     * @param {string} [options.bufferMargin='1000px 0px 1000px 0px'] - IntersectionObserver rootMargin
     */
    constructor(options) {
        this.gridContainer = options.gridContainer;
        this.getBlobUrl = options.getBlobUrl;
        this.revokeBlobUrl = options.revokeBlobUrl;
        this.onOpenLightbox = options.onOpenLightbox;
        this.onStartSlideshow = options.onStartSlideshow;
        this.onToggleFavorite = options.onToggleFavorite;
        this.isFavorited = options.isFavorited;
        this.findIndex = options.findIndex;
        this.getActiveLightboxImageId = options.getActiveLightboxImageId || (() => null);
        this.bufferMargin = options.bufferMargin || '1000px 0px 1000px 0px';

        // Map<HTMLElement, ImageRecord>
        this.itemsMap = new Map();
        // Map<string, HTMLElement> (imageId -> HTMLElement)
        this.idToElement = new Map();

        this.mountedCount = 0;
        this.observer = null;

        this._initObserver();
    }

    _initObserver() {
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const item = entry.target;
                const image = this.itemsMap.get(item);
                if (!image) return;

                if (entry.isIntersecting) {
                    this.mountItem(item, image);
                } else {
                    if (item.dataset.mounted === 'true') {
                        this.unmountItem(item, image);
                    }
                }
            });
        }, {
            root: null, // viewport
            rootMargin: this.bufferMargin,
            threshold: 0
        });
    }

    /**
     * Create and append a virtualized gallery item placeholder to the grid.
     * Starts observed immediately by the windowing engine.
     *
     * @param {object} image - Image record from ImageProcessor.
     * @param {number} [animationDelayMs=0] - Optional staggered delay for initial entrance.
     * @returns {HTMLElement}
     */
    appendItem(image, animationDelayMs = 0) {
        const aspectRatio = (image.height / image.width * 100).toFixed(2);

        const item = document.createElement('div');
        item.className = 'gallery-item virtualized';
        item.dataset.imageId = image.id;
        item.dataset.mounted = 'false';

        if (animationDelayMs > 0) {
            item.style.animationDelay = `${animationDelayMs}ms`;
        }

        // Structural aspect-ratio placeholder (preserves exact column geometry with zero CLS)
        const wrapper = document.createElement('div');
        wrapper.className = 'image-wrapper';
        wrapper.style.paddingBottom = `${aspectRatio}%`;

        item.appendChild(wrapper);

        this.itemsMap.set(item, image);
        this.idToElement.set(image.id, item);

        this.gridContainer.appendChild(item);
        this.observer.observe(item);

        return item;
    }

    /**
     * Hydrate / mount the heavy contents of a gallery item.
     * Obtains blob URL and sets up interactive elements.
     *
     * @param {HTMLElement} item
     * @param {object} image
     */
    mountItem(item, image) {
        if (item.dataset.mounted === 'true') return;

        const wrapper = item.querySelector('.image-wrapper');
        if (!wrapper) return;

        // Allocate on-demand blob URL
        const blobUrl = this.getBlobUrl(image.id);
        if (!blobUrl) return;

        // Build <img> element
        const img = document.createElement('img');
        img.className = 'lazy-image loading-skeleton';
        img.alt = image.name;

        // Load image into DOM
        const tempImg = new Image();
        tempImg.onload = () => {
            img.src = blobUrl;
            img.classList.remove('loading-skeleton');
            img.classList.add('lazy-loaded');
            wrapper.classList.add('loaded');
        };
        tempImg.onerror = () => {
            img.classList.remove('loading-skeleton');
        };
        tempImg.src = blobUrl;

        // Empty placeholder wrapper and insert real image
        wrapper.innerHTML = '';
        wrapper.appendChild(img);

        // Build overlay (XSS-safe textContent)
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

        info.appendChild(title);
        info.appendChild(meta);
        overlay.appendChild(info);

        // Build actions (slideshow + favorite)
        const actions = document.createElement('div');
        actions.className = 'gallery-item-actions';

        const slideshowBtn = document.createElement('button');
        slideshowBtn.className = 'gallery-action-btn slideshow-btn';
        slideshowBtn.title = 'Start slideshow from here';
        slideshowBtn.innerHTML = '<i class="fas fa-play"></i>';

        const isFav = this.isFavorited(image.id);
        const favoriteBtn = document.createElement('button');
        favoriteBtn.className = `gallery-action-btn favorite-btn ${isFav ? 'favorited' : ''}`;
        favoriteBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
        favoriteBtn.dataset.imageId = image.id;
        favoriteBtn.innerHTML = `<i class="${isFav ? 'fas' : 'far'} fa-heart"></i>`;

        actions.appendChild(slideshowBtn);
        actions.appendChild(favoriteBtn);

        // Append overlay and actions to item
        item.appendChild(overlay);
        item.appendChild(actions);

        // Event listeners
        const clickHandler = (e) => {
            if (!e.target.closest('.gallery-action-btn')) {
                const idx = this.findIndex(image.id);
                if (idx !== -1) this.onOpenLightbox(idx);
            }
        };
        item.addEventListener('click', clickHandler);
        item._clickHandler = clickHandler;

        const slideshowHandler = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const idx = this.findIndex(image.id);
            if (idx !== -1) this.onStartSlideshow(idx);
        };
        slideshowBtn.addEventListener('click', slideshowHandler);
        slideshowBtn._slideshowHandler = slideshowHandler;

        const favHandler = (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.onToggleFavorite(image.id);
        };
        favoriteBtn.addEventListener('click', favHandler);
        favoriteBtn._favHandler = favHandler;

        item.classList.remove('virtualized');
        item.classList.add('mounted');
        item.dataset.mounted = 'true';
        this.mountedCount++;
    }

    /**
     * Unmount heavy contents (<img>, listeners, overlay) and revoke blob URL.
     * Retains exact aspect-ratio container wrapper so column height never collapses.
     *
     * @param {HTMLElement} item
     * @param {object} image
     */
    unmountItem(item, image) {
        if (item.dataset.mounted !== 'true') return;

        // Protect active Lightbox image from blob URL revocation
        const activeLightboxId = this.getActiveLightboxImageId();
        if (activeLightboxId !== image.id) {
            this.revokeBlobUrl(image.id);
        }

        // Clean up event listeners
        if (item._clickHandler) {
            item.removeEventListener('click', item._clickHandler);
            delete item._clickHandler;
        }

        const slideshowBtn = item.querySelector('.slideshow-btn');
        if (slideshowBtn && slideshowBtn._slideshowHandler) {
            slideshowBtn.removeEventListener('click', slideshowBtn._slideshowHandler);
            delete slideshowBtn._slideshowHandler;
        }

        const favBtn = item.querySelector('.favorite-btn');
        if (favBtn && favBtn._favHandler) {
            favBtn.removeEventListener('click', favBtn._favHandler);
            delete favBtn._favHandler;
        }

        // Remove overlay and actions
        item.querySelector('.gallery-item-overlay')?.remove();
        item.querySelector('.gallery-item-actions')?.remove();

        // Empty wrapper but keep paddingBottom for zero-CLS preservation
        const wrapper = item.querySelector('.image-wrapper');
        if (wrapper) {
            wrapper.innerHTML = '';
            wrapper.classList.remove('loaded');
        }

        item.classList.remove('mounted');
        item.classList.add('virtualized');
        item.dataset.mounted = 'false';
        this.mountedCount--;
    }

    /**
     * Update favorite state in the DOM if the item is currently mounted.
     *
     * @param {string} imageId
     * @param {boolean} isFav
     */
    updateFavorite(imageId, isFav) {
        const item = this.idToElement.get(imageId);
        if (!item || item.dataset.mounted !== 'true') return;

        const favBtn = item.querySelector('.favorite-btn');
        if (favBtn) {
            favBtn.classList.toggle('favorited', isFav);
            favBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
            favBtn.innerHTML = `<i class="${isFav ? 'fas' : 'far'} fa-heart"></i>`;
        }
    }

    /**
     * Highlight slideshow active item in the grid.
     *
     * @param {string|null} activeImageId
     */
    setSlideshowActive(activeImageId) {
        this.idToElement.forEach((item, id) => {
            item.classList.toggle('slideshow-active', id === activeImageId);
        });
    }

    /**
     * Disconnect observer, clear DOM, and reset all internal state.
     */
    reset() {
        if (this.observer) {
            this.observer.disconnect();
        }
        this.itemsMap.clear();
        this.idToElement.clear();
        this.gridContainer.innerHTML = '';
        this.mountedCount = 0;
        this._initObserver();
    }

    /**
     * Completely destroy the virtual grid instance and release memory.
     */
    destroy() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        this.itemsMap.clear();
        this.idToElement.clear();
        this.mountedCount = 0;
    }

    /**
     * Get performance telemetry metrics.
     * @returns {{total: number, mounted: number, virtualized: number}}
     */
    getStats() {
        const total = this.itemsMap.size;
        return {
            total,
            mounted: this.mountedCount,
            virtualized: Math.max(0, total - this.mountedCount)
        };
    }
}
