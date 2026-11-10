/**
 * LightboxController.js
 * Lightbox modal, slideshow, swipe gestures, keyboard shortcuts and download.
 *
 * Loading strategy (no blank / grey frames):
 *  1. Show the grid thumbnail instantly (already decoded, sized to the original
 *     aspect ratio so nothing jumps).
 *  2. Decode the full-resolution file in the background, then swap it in.
 *  3. If no thumbnail exists, keep the previous image on screen until the new
 *     one is decoded instead of flashing an empty box.
 *
 * Memory: only the current, previous and next full-resolution object URLs are
 * kept alive; everything else is revoked.
 */

import { icon } from './icons.js';

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k     = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i     = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export class LightboxController {
    /**
     * @param {object} elements  - Pre-queried DOM element references.
     * @param {object} callbacks - Functions injected by the app orchestrator:
     *   getThumbUrl(imageId)      → string|null (cached grid thumbnail)
     *   getFilteredImages()       → Array
     *   getCurrentIndex()         → number
     *   setCurrentIndex(n)        → void
     *   isFavorited(imageId)      → boolean
     *   onToggleFavorite(imageId) → void
     *   onSlideshowIndexChange()  → void
     */
    constructor(elements, callbacks) {
        this._el = elements;
        this._cb = callbacks;

        this.isOpen      = false;
        this.isClosing   = false;
        this._closeTimeout = null;

        this.isSlideshow    = false;
        this.isPaused       = false;
        this.slideshowTimer = null;
        this.slideshowSpeed = 3000;

        this._fullUrls    = new Map(); // imageId -> object URL (full resolution)
        this._renderToken = 0;

        this._onResize = () => { if (this.isOpen) this._fitImage(); };
        window.addEventListener('resize', this._onResize);

        this._initTouchSwipe();
        this._initBackdropClick();
    }

    getCurrentIndex() {
        return this._cb.getCurrentIndex();
    }

    // -------------------------------------------------------------------------
    // Open / close
    // -------------------------------------------------------------------------

    open(index) {
        if (this._closeTimeout) {
            clearTimeout(this._closeTimeout);
            this._closeTimeout = null;
        }
        this.isClosing = false;
        this._cb.setCurrentIndex(index);
        this.isOpen = true;

        this._el.lightbox.classList.remove('hidden', 'lightbox-exiting');
        document.body.style.overflow = 'hidden';

        this._render();

        // Force reflow before triggering the CSS transition
        void this._el.lightbox.offsetHeight;
        this._el.lightbox.classList.add('lightbox-active');
    }

    close() {
        if (!this.isOpen || this.isClosing) return;

        this.isClosing = true;
        if (this.isSlideshow) this.stopSlideshow();

        this._el.lightbox.classList.remove('lightbox-active');
        this._el.lightbox.classList.add('lightbox-exiting');

        this._closeTimeout = setTimeout(() => {
            this.isOpen = false;
            this.isClosing = false;
            this._closeTimeout = null;
            this._el.lightbox.classList.remove('lightbox-exiting');
            this._el.lightbox.classList.add('hidden');
            document.body.style.overflow = '';
            this._el.lightboxImage.removeAttribute('src');
            this._releaseFullUrls(new Set());
            this._cb.onClose?.();
        }, 200);
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------

    _fullUrl(image) {
        let url = this._fullUrls.get(image.id);
        if (!url) {
            url = URL.createObjectURL(image.file);
            this._fullUrls.set(image.id, url);
        }
        return url;
    }

    _releaseFullUrls(keepIds) {
        for (const [id, url] of this._fullUrls) {
            if (!keepIds.has(id)) {
                URL.revokeObjectURL(url);
                this._fullUrls.delete(id);
            }
        }
    }

    /** Size the <img> box to the photo's real aspect ratio within the stage. */
    _fitImage() {
        const images = this._cb.getFilteredImages();
        const image  = images[this._cb.getCurrentIndex()];
        const stage  = this._el.lightboxImage.parentElement;
        if (!image || !stage) return;

        const maxW = stage.clientWidth;
        const maxH = stage.clientHeight;
        if (!maxW || !maxH) return;

        // Never upscale in normal view; fill the screen in slideshow mode
        const limit = this.isSlideshow ? Infinity : 1;
        const scale = Math.min(maxW / image.width, maxH / image.height, limit);
        this._el.lightboxImage.style.width  = `${Math.round(image.width * scale)}px`;
        this._el.lightboxImage.style.height = `${Math.round(image.height * scale)}px`;
    }

    _render() {
        const images = this._cb.getFilteredImages();
        const index  = this._cb.getCurrentIndex();
        if (index < 0 || index >= images.length) return;

        const image = images[index];
        const token = ++this._renderToken;
        const { lightboxImage, lightboxTitle, lightboxInfo } = this._el;

        // Text (user-supplied strings via textContent only)
        lightboxTitle.textContent = image.name;
        lightboxInfo.textContent  =
            `${formatFileSize(image.size)} • ${image.width}×${image.height} • ${image.album}`;
        const counter = `${index + 1} / ${images.length}`;
        if (this._el.lightboxCounter)  this._el.lightboxCounter.textContent  = counter;
        if (this._el.slideshowCounter) this._el.slideshowCounter.textContent = counter;
        lightboxImage.alt = image.name;
        this.updateFavoriteIcon();

        // Step 1: instant thumbnail (if the grid already made one)
        const thumb = this._cb.getThumbUrl?.(image.id);
        if (thumb) {
            lightboxImage.src = thumb;
            this._fitImage();
        }

        // Step 2: decode the full-resolution image, then swap
        const full = this._fullUrl(image);
        const loader = new Image();
        loader.decoding = 'async';
        loader.src = full;
        const swap = () => {
            if (token !== this._renderToken || !this.isOpen) return;
            lightboxImage.src = full;
            this._fitImage();
        };
        loader.decode().then(swap, () => {
            if (loader.complete && loader.naturalWidth > 0) swap();
            else {
                loader.onload = swap;
                loader.onerror = swap; // shows the browser's broken-image state
            }
        });

        // Warm up neighbours so next/prev feel instant
        const keep = new Set([image.id]);
        if (images.length > 1) {
            for (const n of [index + 1, index - 1]) {
                const neighbour = images[(n + images.length) % images.length];
                keep.add(neighbour.id);
                const pre = new Image();
                pre.decoding = 'async';
                pre.src = this._fullUrl(neighbour);
                pre.decode().catch(() => {});
            }
        }
        this._releaseFullUrls(keep);
    }

    updateFavoriteIcon() {
        const images = this._cb.getFilteredImages();
        const image  = images[this._cb.getCurrentIndex()];
        if (!image) return;
        const fav = this._cb.isFavorited(image.id);
        const btn = this._el.favoriteBtn;
        btn.classList.toggle('is-favorited', fav);
        btn.title = fav ? 'Remove from favorites (F)' : 'Add to favorites (F)';
        btn.setAttribute('aria-pressed', String(fav));
    }

    // -------------------------------------------------------------------------
    // Navigation
    // -------------------------------------------------------------------------

    navigate(direction) {
        const images = this._cb.getFilteredImages();
        if (images.length === 0) return;
        let idx = this._cb.getCurrentIndex() + direction;

        if (idx < 0) idx = images.length - 1;
        else if (idx >= images.length) idx = 0;

        this._cb.setCurrentIndex(idx);
        this._render();
        this._cb.onSlideshowIndexChange?.();

        // Manual navigation restarts the countdown
        if (this.isSlideshow && !this.isPaused) this._restartTimer();
    }

    // -------------------------------------------------------------------------
    // Slideshow
    // -------------------------------------------------------------------------

    startSlideshow(startIndex = 0) {
        const images = this._cb.getFilteredImages();
        if (images.length === 0) return;

        const validIndex = Math.max(0, Math.min(startIndex, images.length - 1));

        this.isSlideshow = true;
        this.isPaused = false;
        this._el.lightbox.classList.add('slideshow-mode');
        this._el.slideshowControls.classList.remove('hidden');
        this._el.slideshowBtn.innerHTML = icon('stop');
        this._el.slideshowBtn.setAttribute('aria-pressed', 'true');
        this._setPlayPauseIcon();

        if (!this.isOpen) {
            this.open(validIndex);
        } else {
            this._cb.setCurrentIndex(validIndex);
            this._render();
        }
        this._fitImage();
        this._cb.onSlideshowIndexChange?.();
        this._restartTimer();
    }

    stopSlideshow() {
        this.isSlideshow = false;
        this.isPaused = false;
        this._el.slideshowControls.classList.add('hidden');
        this._el.slideshowBtn.innerHTML = icon('play');
        this._el.slideshowBtn.setAttribute('aria-pressed', 'false');
        this._el.lightbox?.classList.remove('slideshow-mode');

        if (this.slideshowTimer) {
            clearInterval(this.slideshowTimer);
            this.slideshowTimer = null;
        }
        this._cb.onSlideshowStop?.();
        if (this.isOpen) this._fitImage();
    }

    toggleSlideshowPlayPause() {
        if (!this.isSlideshow) return;
        this.isPaused = !this.isPaused;
        if (this.isPaused) {
            clearInterval(this.slideshowTimer);
            this.slideshowTimer = null;
        } else {
            this._restartTimer();
        }
        this._setPlayPauseIcon();
    }

    _setPlayPauseIcon() {
        const btn = document.getElementById('slideshowPlayPauseBtn');
        if (!btn) return;
        btn.innerHTML = icon(this.isPaused ? 'play' : 'pause');
        btn.setAttribute('aria-label', this.isPaused ? 'Play' : 'Pause');
    }

    setSlideshowSpeed(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return;
        this.slideshowSpeed = ms;
        if (this.isSlideshow && !this.isPaused) this._restartTimer();
    }

    _restartTimer() {
        if (this.slideshowTimer) clearInterval(this.slideshowTimer);
        this.slideshowTimer = setInterval(() => this.navigate(1), this.slideshowSpeed);
    }

    // -------------------------------------------------------------------------
    // Favorite & download
    // -------------------------------------------------------------------------

    toggleFavorite() {
        const images = this._cb.getFilteredImages();
        const image  = images[this._cb.getCurrentIndex()];
        if (!image?.id) return;
        this._cb.onToggleFavorite(image.id);
        this.updateFavoriteIcon();
    }

    downloadCurrentImage() {
        const images = this._cb.getFilteredImages();
        const image  = images[this._cb.getCurrentIndex()];
        if (!image) return;

        const link    = document.createElement('a');
        link.href     = this._fullUrl(image);
        link.download = image.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    // -------------------------------------------------------------------------
    // Keyboard shortcuts
    // -------------------------------------------------------------------------

    handleKeydown(event) {
        if (!this.isOpen) return;

        switch (event.key) {
            case 'Escape':
                this.close();
                break;
            case 'ArrowLeft':
                event.preventDefault();
                this.navigate(-1);
                break;
            case 'ArrowRight':
                event.preventDefault();
                this.navigate(1);
                break;
            case ' ':
                event.preventDefault();
                if (this.isSlideshow) this.toggleSlideshowPlayPause();
                else this.startSlideshow(this._cb.getCurrentIndex());
                break;
            case 'f': case 'F':
                event.preventDefault();
                this.toggleFavorite();
                break;
            case 'd': case 'D':
                event.preventDefault();
                this.downloadCurrentImage();
                break;
        }
    }

    // -------------------------------------------------------------------------
    // Touch swipe (mobile)
    // -------------------------------------------------------------------------

    _initTouchSwipe() {
        let startX = 0;
        let startY = 0;
        let tracking = false;
        const MIN_SWIPE = 50;

        this._el.lightbox.addEventListener('touchstart', e => {
            if (e.touches.length !== 1) { tracking = false; return; }
            tracking = true;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }, { passive: true });

        this._el.lightbox.addEventListener('touchend', e => {
            if (!tracking) return;
            tracking = false;
            const dx = e.changedTouches[0].clientX - startX;
            const dy = e.changedTouches[0].clientY - startY;
            // Horizontal swipe only (ignore vertical scrolls / pinch)
            if (Math.abs(dx) > MIN_SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5) {
                this.navigate(dx > 0 ? -1 : 1);
            }
        }, { passive: true });
    }

    // -------------------------------------------------------------------------
    // Backdrop click
    // -------------------------------------------------------------------------

    _initBackdropClick() {
        this._el.lightbox?.addEventListener('click', (e) => {
            if (!this.isOpen || this.isClosing) return;
            const isInteractive = e.target.closest(
                '#lightboxImage, .lightbox-info-bar, #prevImage, #nextImage, #closeLightbox, #slideshowControls, button, a, select, input'
            );
            if (!isInteractive) this.close();
        });
    }

    destroy() {
        if (this._closeTimeout) clearTimeout(this._closeTimeout);
        if (this.slideshowTimer) clearInterval(this.slideshowTimer);
        this._closeTimeout = null;
        this.slideshowTimer = null;
        window.removeEventListener('resize', this._onResize);
        this._releaseFullUrls(new Set());
        document.body.style.overflow = '';
    }
}
