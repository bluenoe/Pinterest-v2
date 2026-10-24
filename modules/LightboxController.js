/**
 * LightboxController.js
 * Single-responsibility module for lightbox modal, slideshow, swipe gestures,
 * keyboard navigation, and image download.
 *
 * Responsibilities:
 *  - Open / close lightbox modal and manage body-scroll lock.
 *  - Render the correct image, title, info, and favorite state.
 *  - Slideshow: start from any index, play/pause, stop, configurable interval.
 *  - Touch swipe gestures (mobile).
 *  - Keyboard shortcuts: ArrowLeft, ArrowRight, Space, Escape, F, D.
 *  - Download current image (via on-demand blob URL).
 *  - Auto-scroll (continuous viewport scroll with rAF loop).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a byte count as a human-readable string.
 * (Duplicate of the one in GalleryRenderer — kept here to avoid a cross-module
 * dependency on a pure-utility function.  If desired, extract to a shared
 * utils.js and import from both places.)
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k     = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i     = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ---------------------------------------------------------------------------
// LightboxController class
// ---------------------------------------------------------------------------

export class LightboxController {
    /**
     * @param {object} elements  - Pre-queried DOM element references.
     * @param {object} callbacks - Functions injected by the app orchestrator:
     *   getBlobUrl(imageId)       → string|null
     *   getFilteredImages()       → Array
     *   getCurrentIndex()         → number
     *   setCurrentIndex(n)        → void
     *   isFavorited(imageId)      → boolean
     *   onToggleFavorite(imageId) → void
     *   onSlideshowIndexChange()  → void  (called after navigation)
     */
    constructor(elements, callbacks) {
        this._el = elements;
        this._cb = callbacks;

        this.isOpen      = false;
        this.isSlideshow = false;
        this.slideshowTimer = null;
        this.slideshowSpeed = 3000;

        this.isAutoScrolling = false;
        this.autoScrollSpeed = 1; // px per rAF frame

        this._initTouchSwipe();
    }

    // -------------------------------------------------------------------------
    // Open / close
    // -------------------------------------------------------------------------

    open(index) {
        this._cb.setCurrentIndex(index);
        this.isOpen = true;
        this._el.lightbox.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        this._render();
    }

    close() {
        this.isOpen = false;
        this._el.lightbox.classList.add('hidden');
        document.body.style.overflow = '';

        const container = document.querySelector('.lightbox-content-container');
        container?.classList.remove('slideshow-mode');
        this._el.lightbox.classList.remove('slideshow-mode');

        if (this.isSlideshow) this.stopSlideshow();
    }

    // -------------------------------------------------------------------------
    // Image rendering
    // -------------------------------------------------------------------------

    /**
     * Refresh the lightbox to show the image at the current index.
     * P0 FIX 1: title/info via textContent.
     * P0 FIX 2: blob URL obtained on demand via getBlobUrl().
     */
    _render() {
        const images = this._cb.getFilteredImages();
        const index  = this._cb.getCurrentIndex();
        if (index < 0 || index >= images.length) return;

        const image  = images[index];
        const { lightboxImage, lightboxTitle, lightboxInfo, favoriteBtn } = this._el;

        // Loading state
        lightboxImage.classList.add('loading');
        lightboxImage.style.opacity = '0.5';

        // P0 FIX 2: on-demand blob URL
        const blobUrl = this._cb.getBlobUrl(image.id);

        const preload   = new Image();
        preload.onload  = () => {
            lightboxImage.src = blobUrl;
            lightboxImage.classList.remove('loading');
            lightboxImage.style.opacity = '1';
        };
        preload.onerror = () => {
            lightboxImage.classList.remove('loading');
            lightboxImage.style.opacity = '1';
        };
        preload.src = blobUrl;

        // P0 FIX 1: textContent only for user-supplied strings
        lightboxTitle.textContent = image.name;
        lightboxInfo.textContent  =
            `${formatFileSize(image.size)} • ${image.width}×${image.height} • ${image.album}`;

        // Favorite button — icon-only innerHTML is safe (no user data)
        const fav = this._cb.isFavorited(image.id);
        favoriteBtn.innerHTML = `<i class="${fav ? 'fas' : 'far'} fa-heart"></i>`;
        favoriteBtn.classList.toggle('text-red-500', fav);

        // Slideshow active gallery-item highlight
        document.querySelectorAll('.gallery-item').forEach((el, i) => {
            el.classList.toggle('slideshow-active', this.isSlideshow && i === index);
        });
    }

    // -------------------------------------------------------------------------
    // Navigation
    // -------------------------------------------------------------------------

    navigate(direction) {
        const images = this._cb.getFilteredImages();
        let idx      = this._cb.getCurrentIndex() + direction;

        if (idx < 0)               idx = images.length - 1;
        else if (idx >= images.length) idx = 0;

        this._cb.setCurrentIndex(idx);
        this._render();
    }

    // -------------------------------------------------------------------------
    // Slideshow
    // -------------------------------------------------------------------------

    startSlideshow(startIndex = 0) {
        const images     = this._cb.getFilteredImages();
        if (images.length === 0) return;

        const validIndex = Math.max(0, Math.min(startIndex, images.length - 1));

        if (!this.isOpen) {
            this.open(validIndex);
        } else {
            this._cb.setCurrentIndex(validIndex);
            this._render();
        }

        this.isSlideshow = true;
        this._el.slideshowControls.classList.remove('hidden');
        this._el.slideshowBtn.innerHTML = '<i class="fas fa-stop"></i>';

        document.querySelector('.lightbox-content-container')?.classList.add('slideshow-mode');
        this._el.lightbox.classList.add('slideshow-mode');

        this._restartTimer();
        document.getElementById('slideshowPlayPauseBtn').innerHTML = '<i class="fas fa-pause"></i>';
    }

    stopSlideshow() {
        this.isSlideshow = false;
        this._el.slideshowControls.classList.add('hidden');
        this._el.slideshowBtn.innerHTML = '<i class="fas fa-play"></i>';

        document.querySelector('.lightbox-content-container')?.classList.remove('slideshow-mode');
        this._el.lightbox?.classList.remove('slideshow-mode');

        if (this.slideshowTimer) {
            clearInterval(this.slideshowTimer);
            this.slideshowTimer = null;
        }

        document.querySelectorAll('.slideshow-active').forEach(el => {
            el.classList.remove('slideshow-active');
        });
    }

    togglePlayPause() {
        if (this.slideshowTimer) {
            clearInterval(this.slideshowTimer);
            this.slideshowTimer = null;
            document.getElementById('slideshowPlayPauseBtn').innerHTML = '<i class="fas fa-play"></i>';
        } else {
            this._restartTimer();
            document.getElementById('slideshowPlayPauseBtn').innerHTML = '<i class="fas fa-pause"></i>';
        }
    }

    setSpeed(ms) {
        this.slideshowSpeed = ms;
        if (this.isSlideshow) this._restartTimer();
    }

    _restartTimer() {
        if (this.slideshowTimer) clearInterval(this.slideshowTimer);
        this.slideshowTimer = setInterval(() => this.navigate(1), this.slideshowSpeed);
    }

    // -------------------------------------------------------------------------
    // Favorite toggle (delegated to orchestrator callback)
    // -------------------------------------------------------------------------

    toggleFavorite() {
        const images = this._cb.getFilteredImages();
        const index  = this._cb.getCurrentIndex();
        if (index < 0 || index >= images.length) return;

        const image = images[index];
        if (!image?.id) return;

        this._cb.onToggleFavorite(image.id);
        this._render(); // Refresh the heart icon
    }

    // -------------------------------------------------------------------------
    // Download
    // -------------------------------------------------------------------------

    downloadImage() {
        const images  = this._cb.getFilteredImages();
        const index   = this._cb.getCurrentIndex();
        if (index < 0 || index >= images.length) return;

        const image   = images[index];
        const blobUrl = this._cb.getBlobUrl(image.id);
        if (!blobUrl) return;

        const link      = document.createElement('a');
        link.href       = blobUrl;
        link.download   = image.name; // attribute value — safe
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
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
                this.isSlideshow ? this.togglePlayPause() : this.startSlideshow();
                break;
            case 'f': case 'F':
                event.preventDefault();
                this.toggleFavorite();
                break;
            case 'd': case 'D':
                event.preventDefault();
                this.downloadImage();
                break;
        }
    }

    // -------------------------------------------------------------------------
    // Touch swipe (mobile)
    // -------------------------------------------------------------------------

    _initTouchSwipe() {
        let startX = 0;
        const MIN_SWIPE = 50;

        this._el.lightbox.addEventListener('touchstart', e => {
            startX = e.changedTouches[0].screenX;
        }, { passive: true });

        this._el.lightbox.addEventListener('touchend', e => {
            const delta = e.changedTouches[0].screenX - startX;
            if (Math.abs(delta) > MIN_SWIPE) {
                this.navigate(delta > 0 ? -1 : 1);
            }
        }, { passive: true });
    }

    // -------------------------------------------------------------------------
    // Auto-scroll (continuous viewport scroll)
    // -------------------------------------------------------------------------

    toggleAutoScroll(autoScrollBtn, getCurrentPage, itemsPerPage, getFilteredImages) {
        this.isAutoScrolling = !this.isAutoScrolling;

        autoScrollBtn?.classList.toggle('auto-scrolling', this.isAutoScrolling);
        autoScrollBtn?.classList.toggle('text-pinterest-red', this.isAutoScrolling);

        if (this.isAutoScrolling) {
            this._autoScrollLoop(autoScrollBtn, getCurrentPage, itemsPerPage, getFilteredImages);
        }
    }

    _autoScrollLoop(autoScrollBtn, getCurrentPage, itemsPerPage, getFilteredImages) {
        if (!this.isAutoScrolling) return;

        window.scrollBy(0, this.autoScrollSpeed);

        const { scrollHeight } = document.documentElement;
        const { scrollY, innerHeight } = window;

        if (scrollY + innerHeight >= scrollHeight - 10) {
            const hasMore = getCurrentPage() * itemsPerPage < getFilteredImages().length;
            if (!hasMore) {
                this.isAutoScrolling = false;
                autoScrollBtn?.classList.remove('auto-scrolling', 'text-pinterest-red');
                return;
            }
        }

        requestAnimationFrame(() =>
            this._autoScrollLoop(autoScrollBtn, getCurrentPage, itemsPerPage, getFilteredImages)
        );
    }
}
