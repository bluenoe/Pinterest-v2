/**
 * script.js
 * Application Orchestrator / Coordinator for Pinterest Photo Gallery.
 *
 * Coordinates:
 *  - StorageService: theme preferences and persistent favorites.
 *  - ImageProcessor: deterministic ID generation, metadata extraction, drag-and-drop ingestion.
 *  - ThumbnailService: off-main-thread thumbnails, placeholder colours, bounded cache.
 *  - VirtualGrid: stable masonry layout, viewport windowing, smooth image reveal.
 *  - GalleryRenderer: filters, header counters, folder list, infinite scroll.
 *  - LightboxController: modal viewer, slideshow, swipe, keyboard shortcuts.
 */

import {
    loadFavorites,
    toggleFavorite as storageToggleFavorite,
    applyInitialTheme,
    saveTheme
} from './modules/StorageService.js';

import {
    processImages,
    collectDroppedImageFiles,
    IMAGE_EXTENSIONS
} from './modules/ImageProcessor.js';

import {
    applyFilters,
    renderAlbumSelector,
    renderPhotoCount,
    renderFavoritesBadge,
    renderSelectedFolders,
    setupInfiniteScroll
} from './modules/GalleryRenderer.js';

import { VirtualGrid } from './modules/VirtualGrid.js';
import { ThumbnailService } from './modules/ThumbnailService.js';
import { LightboxController } from './modules/LightboxController.js';

const PAGE_SIZE = 60;
const PREFETCH_DISTANCE = 2000; // px below the viewport at which the next page is added
const AUTO_SCROLL_PX_PER_SECOND = 60;

export class PhotoGallery {
    constructor() {
        // Master image records (raw File references)
        this.images = [];
        this.filteredImages = [];

        // State & pagination
        this.currentIndex = 0;
        this.currentPage = 0;
        this.itemsPerPage = PAGE_SIZE;
        this.currentAlbum = 'all';
        this.albums = new Map();
        this.showFavoritesOnly = false;
        this.searchQuery = '';
        this._searchDebounceTimer = null;
        this.infiniteScrollObserver = null;
        this._prefetchFrame = 0;

        // Favorites Set<string>
        this.favorites = loadFavorites();

        // Multi-folder model: Array<{name: string, files: File[], selected: boolean}>
        this.selectedFolders = [];

        // Auto-scroll state
        this.isAutoScrolling = false;
        this._autoScrollLast = 0;
        this._autoScrollCarry = 0;

        this._initElements();
        applyInitialTheme();

        this.thumbnails = new ThumbnailService();

        this.virtualGrid = new VirtualGrid({
            gridContainer: this.galleryGrid,
            thumbnails: this.thumbnails,
            onOpenLightbox: (idx) => this.lightboxController.open(idx),
            onStartSlideshow: (idx) => this.lightboxController.startSlideshow(idx),
            onToggleFavorite: (id) => this.toggleFavorite(id),
            isFavorited: (id) => this.favorites.has(id),
            findIndex: (id) => this.filteredImages.findIndex(img => img.id === id)
        });

        this.lightboxController = new LightboxController(
            {
                lightbox: this.lightbox,
                lightboxImage: this.lightboxImage,
                lightboxTitle: this.lightboxTitle,
                lightboxInfo: this.lightboxInfo,
                lightboxCounter: document.getElementById('lightboxCounter'),
                slideshowCounter: document.getElementById('slideshowCounter'),
                favoriteBtn: this.favoriteBtn,
                downloadBtn: this.downloadBtn,
                slideshowControls: this.slideshowControls,
                slideshowBtn: this.slideshowBtn,
                slideshowIntervalSelect: this.slideshowIntervalSelect
            },
            {
                getThumbUrl: (id) => this.thumbnails.getCached(id),
                getFilteredImages: () => this.filteredImages,
                getCurrentIndex: () => this.currentIndex,
                setCurrentIndex: (idx) => { this.currentIndex = idx; },
                isFavorited: (id) => this.favorites.has(id),
                onToggleFavorite: (id) => this.toggleFavorite(id),
                onSlideshowIndexChange: () => {
                    if (this.lightboxController?.isSlideshow) {
                        this.virtualGrid.setSlideshowActive(this.filteredImages[this.currentIndex]?.id);
                    }
                },
                onSlideshowStop: () => this.virtualGrid.setSlideshowActive(null)
            }
        );

        this._initEventListeners();
        renderFavoritesBadge(this.favoritesToggle, this.favorites.size);
        this._updateToggleStates();
    }

    // -------------------------------------------------------------------------
    // DOM Initialization
    // -------------------------------------------------------------------------

    _initElements() {
        // Welcome screen
        this.welcomeScreen        = document.getElementById('welcomeScreen');
        this.dropZone             = document.getElementById('dropZone');
        this.folderInput          = document.getElementById('folderInput');
        this.chooseFolderLabel    = document.getElementById('chooseFolderLabel');
        this.startGalleryBtn      = document.getElementById('startGallery');
        this.selectedFoldersList  = document.getElementById('selectedFoldersList');

        // Gallery
        this.galleryContainer     = document.getElementById('galleryContainer');
        this.galleryGrid          = document.getElementById('galleryGrid');
        this.loadingOverlay       = document.getElementById('loadingOverlay');
        this.photoCount           = document.getElementById('photoCount');
        this.noResults            = document.getElementById('noResults');
        this.clearFiltersBtn      = document.getElementById('clearFiltersBtn');

        // Search & Filters
        this.searchInput          = document.getElementById('searchInput');
        this.clearSearchBtn       = document.getElementById('clearSearchBtn');
        this.albumSelector        = document.getElementById('albumSelector');
        this.albumSelect          = document.getElementById('albumSelect');
        this.favoritesToggle      = document.getElementById('favoritesToggle');

        // Lightbox
        this.lightbox             = document.getElementById('lightbox');
        this.lightboxImage        = document.getElementById('lightboxImage');
        this.lightboxTitle        = document.getElementById('lightboxTitle');
        this.lightboxInfo         = document.getElementById('lightboxInfo');
        this.favoriteBtn          = document.getElementById('favoriteBtn');
        this.downloadBtn          = document.getElementById('downloadBtn');

        // Controls
        this.darkModeToggle       = document.getElementById('darkModeToggle');
        this.slideshowBtn         = document.getElementById('slideshowBtn');
        this.loadMoreBtn          = document.getElementById('loadMoreBtn');
        this.loadMoreContainer    = document.getElementById('loadMoreContainer');
        this.autoScrollBtn        = document.getElementById('autoScrollBtn');

        // Slideshow controls
        this.slideshowControls       = document.getElementById('slideshowControls');
        this.slideshowIntervalSelect = document.getElementById('slideshowInterval');
    }

    _initEventListeners() {
        // Welcome screen
        this.folderInput?.addEventListener('change', (e) => this.handleFolderSelection(e));
        this.startGalleryBtn?.addEventListener('click', () => this.startGallery());
        this._initDragAndDrop();

        // Search & Filter
        this.searchInput?.addEventListener('input', (e) => {
            const value = e.target.value;
            this.clearSearchBtn?.classList.toggle('hidden', value.length === 0);
            clearTimeout(this._searchDebounceTimer);
            this._searchDebounceTimer = setTimeout(() => this.handleSearch(value), 200);
        });
        this.searchInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.clearSearch();
                this.searchInput.blur();
            }
        });
        this.clearSearchBtn?.addEventListener('click', () => {
            this.clearSearch();
            this.searchInput?.focus();
        });
        this.clearFiltersBtn?.addEventListener('click', () => this.clearAllFilters());
        this.albumSelect?.addEventListener('change', (e) => this.handleAlbumChange(e.target.value));
        this.favoritesToggle?.addEventListener('click', () => this.toggleFavoritesView());

        // Lightbox modal buttons
        document.getElementById('closeLightbox')?.addEventListener('click', () => this.lightboxController.close());
        document.getElementById('prevImage')?.addEventListener('click', () => this.lightboxController.navigate(-1));
        document.getElementById('nextImage')?.addEventListener('click', () => this.lightboxController.navigate(1));
        this.downloadBtn?.addEventListener('click', () => this.lightboxController.downloadCurrentImage());
        this.favoriteBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.lightboxController.toggleFavorite();
        });

        // Slideshow controls
        document.getElementById('slideshowPlayPauseBtn')?.addEventListener('click', () => {
            this.lightboxController.toggleSlideshowPlayPause();
        });
        document.getElementById('slideshowPrevBtn')?.addEventListener('click', () => {
            this.lightboxController.navigate(-1);
        });
        document.getElementById('slideshowNextBtn')?.addEventListener('click', () => {
            this.lightboxController.navigate(1);
        });
        document.getElementById('slideshowStopBtn')?.addEventListener('click', () => {
            this.lightboxController.stopSlideshow();
        });
        this.slideshowIntervalSelect?.addEventListener('change', (e) => {
            this.lightboxController.setSlideshowSpeed(parseInt(e.target.value, 10));
        });

        // Header actions
        this.darkModeToggle?.addEventListener('click', () => this.toggleDarkMode());
        this.slideshowBtn?.addEventListener('click', () => {
            if (this.lightboxController.isSlideshow) {
                this.lightboxController.stopSlideshow();
            } else {
                this.lightboxController.startSlideshow(0);
            }
        });
        this.autoScrollBtn?.addEventListener('click', () => this.toggleAutoScroll());
        this.loadMoreBtn?.addEventListener('click', () => this.loadMoreImages());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (this.lightboxController.isOpen) {
                this.lightboxController.handleKeydown(e);
                return;
            }
            const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
            if (e.key === '/' && !typing && !this.galleryContainer.classList.contains('hidden')) {
                e.preventDefault();
                this.searchInput?.focus();
            }
        });

        // Stop auto-scroll when the user takes over
        const stopOnUserScroll = (e) => {
            if (!this.isAutoScrolling) return;
            if (e.target.closest?.('#autoScrollBtn')) return; // the button handles itself
            this.toggleAutoScroll(false);
        };
        window.addEventListener('wheel', stopOnUserScroll, { passive: true });
        window.addEventListener('touchstart', stopOnUserScroll, { passive: true });
    }

    _initDragAndDrop() {
        let depth = 0;
        const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
        const welcomeVisible = () => this.welcomeScreen && this.welcomeScreen.style.display !== 'none';

        window.addEventListener('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth++;
            if (welcomeVisible()) this.dropZone?.classList.add('is-dragover');
        });
        window.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = welcomeVisible() ? 'copy' : 'none';
        });
        window.addEventListener('dragleave', (e) => {
            if (!hasFiles(e)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) this.dropZone?.classList.remove('is-dragover');
        });
        window.addEventListener('drop', async (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth = 0;
            this.dropZone?.classList.remove('is-dragover');
            if (welcomeVisible() && e.dataTransfer.files.length > 0) {
                await this.handleDroppedFiles(e.dataTransfer);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Folder Ingestion & Multi-Folder Management
    // -------------------------------------------------------------------------

    handleFolderSelection(event) {
        const files = Array.from(event.target.files);
        if (files.length === 0) return;

        const imageFiles = files.filter(f => IMAGE_EXTENSIONS.test(f.name));
        if (imageFiles.length === 0) {
            this.showError('No supported images found in selected folder.');
            this.folderInput.value = '';
            return;
        }

        const firstPath = imageFiles[0].webkitRelativePath || imageFiles[0].name;
        const parts = firstPath.split('/');
        this._addFolder(parts.length > 1 ? parts[0] : 'Selected Folder', imageFiles);
        this.folderInput.value = '';
    }

    async handleDroppedFiles(dataTransfer) {
        this.showLoading(true);
        try {
            const imageFiles = await collectDroppedImageFiles(dataTransfer);
            if (imageFiles.length === 0) {
                this.showError('No supported images found in dropped files or folders.');
                return;
            }
            const firstPath = imageFiles[0].webkitRelativePath || imageFiles[0].name;
            const parts = firstPath.split('/');
            this._addFolder(parts.length > 1 ? parts[0] : 'Dropped Files', imageFiles);
        } catch (err) {
            console.error('Error handling dropped files:', err);
            this.showError('Failed to process dropped files.');
        } finally {
            this.showLoading(false);
        }
    }

    _addFolder(baseName, files) {
        const name = this.selectedFolders.some(f => f.name === baseName)
            ? `${baseName} (${this.selectedFolders.length + 1})`
            : baseName;
        this.selectedFolders.push({ name, files, selected: true });
        this.renderFolders();
    }

    renderFolders() {
        renderSelectedFolders(
            this.selectedFolders,
            this.selectedFoldersList,
            this.startGalleryBtn,
            (idx) => {
                this.selectedFolders[idx].selected = !this.selectedFolders[idx].selected;
                this.renderFolders();
            },
            () => {
                this.selectedFolders.forEach(f => f.selected = true);
                this.renderFolders();
            },
            () => {
                this.selectedFolders.forEach(f => f.selected = false);
                this.renderFolders();
            },
            (idx) => {
                this.selectedFolders.splice(idx, 1);
                this.renderFolders();
            }
        );

        const label = this.chooseFolderLabel?.querySelector('[data-label]');
        if (label) {
            label.textContent = this.selectedFolders.length > 0 ? 'Add another folder' : 'Choose a folder';
        }
    }

    // -------------------------------------------------------------------------
    // Gallery Start & Rendering
    // -------------------------------------------------------------------------

    async startGallery() {
        const activeFiles = this.selectedFolders
            .filter(f => f.selected !== false)
            .flatMap(f => f.files);

        if (activeFiles.length === 0) return;

        this.showLoading(true);
        this.welcomeScreen.style.display = 'none';
        this.galleryContainer.classList.remove('hidden');

        try {
            this.thumbnails.clear();
            this.images = await processImages(activeFiles, new Map(), (done, total) => {
                this.updateLoadingProgress(done, total);
            });
            this.filteredImages = [...this.images];

            this._organizeAlbums();
            this.renderGallery();
            this.updatePhotoCount();
        } catch (err) {
            console.error('Error starting gallery:', err);
            this.showError('Failed to load gallery images. Please try again.');
        } finally {
            this.showLoading(false);
        }
    }

    _organizeAlbums() {
        this.albums.clear();
        this.albums.set('all', this.images);

        this.images.forEach(img => {
            if (!this.albums.has(img.album)) {
                this.albums.set(img.album, []);
            }
            this.albums.get(img.album).push(img);
        });

        renderAlbumSelector(this.albums, this.albumSelect, this.albumSelector);
    }

    renderGallery() {
        this.currentPage = 0;
        this.virtualGrid.reset();
        this.loadMoreImages();
    }

    loadMoreImages() {
        const startIndex = this.currentPage * this.itemsPerPage;
        const endIndex = Math.min(startIndex + this.itemsPerPage, this.filteredImages.length);

        for (let i = startIndex; i < endIndex; i++) {
            this.virtualGrid.appendItem(this.filteredImages[i]);
        }
        this.currentPage++;

        // One infinite-scroll observer per render (never stacked)
        if (this.currentPage === 1) {
            this.infiniteScrollObserver?.disconnect();
            this.infiniteScrollObserver = setupInfiniteScroll(
                this.loadMoreContainer,
                () => this.loadMoreImages(),
                () => this.hasMoreImages(),
                PREFETCH_DISTANCE
            );
        }

        this.noResults?.classList.toggle('hidden', this.filteredImages.length > 0);
        this.updatePhotoCount();
        this._schedulePrefetchCheck();
    }

    /**
     * IntersectionObserver only fires when visibility changes. On tall screens
     * the sentinel can stay in range after a page is added, so check again.
     */
    _schedulePrefetchCheck() {
        cancelAnimationFrame(this._prefetchFrame);
        this._prefetchFrame = requestAnimationFrame(() => {
            const sentinel = document.getElementById('infiniteScrollSentinel');
            if (!sentinel || !this.hasMoreImages()) return;
            if (sentinel.getBoundingClientRect().top < window.innerHeight + PREFETCH_DISTANCE) {
                this.loadMoreImages();
            }
        });
    }

    hasMoreImages() {
        return this.currentPage * this.itemsPerPage < this.filteredImages.length;
    }

    // -------------------------------------------------------------------------
    // Filtering & Search
    // -------------------------------------------------------------------------

    handleSearch(query) {
        this.searchQuery = (query || '').toLowerCase().trim();
        this.applyFilters();
    }

    clearSearch() {
        clearTimeout(this._searchDebounceTimer);
        if (this.searchInput) this.searchInput.value = '';
        this.clearSearchBtn?.classList.add('hidden');
        if (this.searchQuery) this.handleSearch('');
    }

    clearAllFilters() {
        clearTimeout(this._searchDebounceTimer);
        if (this.searchInput) this.searchInput.value = '';
        this.clearSearchBtn?.classList.add('hidden');
        this.searchQuery = '';
        this.currentAlbum = 'all';
        if (this.albumSelect) this.albumSelect.value = 'all';
        this.showFavoritesOnly = false;
        this._updateToggleStates();
        this.applyFilters();
    }

    handleAlbumChange(album) {
        this.currentAlbum = album;
        this.applyFilters();
    }

    toggleFavoritesView() {
        this.showFavoritesOnly = !this.showFavoritesOnly;
        this._updateToggleStates();
        this.applyFilters();
    }

    applyFilters() {
        this.filteredImages = applyFilters(
            this.images,
            this.currentAlbum,
            this.showFavoritesOnly,
            this.favorites,
            this.searchQuery
        );

        window.scrollTo({ top: 0, behavior: 'instant' });
        this.renderGallery();
        this.updatePhotoCount();
    }

    updatePhotoCount() {
        renderPhotoCount(this.photoCount, this.filteredImages.length, this.favorites.size);
    }

    _updateToggleStates() {
        this.favoritesToggle?.classList.toggle('is-active', this.showFavoritesOnly);
        this.favoritesToggle?.setAttribute('aria-pressed', String(this.showFavoritesOnly));
        this.autoScrollBtn?.classList.toggle('is-active', this.isAutoScrolling);
        this.autoScrollBtn?.setAttribute('aria-pressed', String(this.isAutoScrolling));
    }

    // -------------------------------------------------------------------------
    // Favorites
    // -------------------------------------------------------------------------

    toggleFavorite(imageId) {
        if (!imageId) return;

        storageToggleFavorite(this.favorites, imageId);
        const isFav = this.favorites.has(imageId);

        this.virtualGrid.updateFavorite(imageId, isFav);
        if (this.lightboxController.isOpen) this.lightboxController.updateFavoriteIcon();
        renderFavoritesBadge(this.favoritesToggle, this.favorites.size);
        this.updatePhotoCount();

        // Favorites-only view: drop the card (but not while the lightbox is
        // showing it, otherwise the viewer's index would shift under the user)
        if (this.showFavoritesOnly && !isFav && !this.lightboxController.isOpen) {
            this.applyFilters();
        }
    }

    // -------------------------------------------------------------------------
    // Theme & Auto-Scroll
    // -------------------------------------------------------------------------

    toggleDarkMode() {
        const root = document.documentElement;
        root.classList.add('theme-switching');
        const isDark = root.classList.toggle('dark');
        saveTheme(isDark ? 'dark' : 'light');
        setTimeout(() => root.classList.remove('theme-switching'), 350);
    }

    toggleAutoScroll(force) {
        this.isAutoScrolling = typeof force === 'boolean' ? force : !this.isAutoScrolling;
        this.autoScrollBtn?.classList.toggle('auto-scrolling', this.isAutoScrolling);
        this._updateToggleStates();

        if (this.isAutoScrolling) {
            this._autoScrollLast = performance.now();
            this._autoScrollCarry = 0;
            requestAnimationFrame((t) => this._autoScrollLoop(t));
        }
    }

    /** Time-based so speed is the same on 60Hz and 120Hz screens. */
    _autoScrollLoop(now) {
        if (!this.isAutoScrolling) return;

        const dt = Math.min(100, now - this._autoScrollLast);
        this._autoScrollLast = now;
        this._autoScrollCarry += (AUTO_SCROLL_PX_PER_SECOND * dt) / 1000;
        const step = Math.floor(this._autoScrollCarry);
        if (step > 0) {
            this._autoScrollCarry -= step;
            window.scrollBy(0, step);
        }

        const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
        if (atBottom && !this.hasMoreImages()) {
            this.toggleAutoScroll(false);
            return;
        }
        requestAnimationFrame((t) => this._autoScrollLoop(t));
    }

    // -------------------------------------------------------------------------
    // UI Helpers & Cleanup
    // -------------------------------------------------------------------------

    showLoading(show) {
        this.loadingOverlay?.classList.toggle('hidden', !show);
        if (show) this.updateLoadingProgress(0, 0);
    }

    updateLoadingProgress(done, total) {
        const label = document.getElementById('loadingText');
        if (!label) return;
        label.textContent = total > 0
            ? `Loading images... ${done}/${total}`
            : 'Loading images...';
    }

    showError(message) {
        console.error('Gallery Error:', message);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'fixed top-4 right-4 bg-red-500 text-white px-4 py-2 rounded-lg shadow-lg z-50 transition-opacity';
        errorDiv.setAttribute('role', 'alert');
        errorDiv.textContent = message;
        document.body.appendChild(errorDiv);

        setTimeout(() => {
            errorDiv.style.opacity = '0';
            setTimeout(() => errorDiv.remove(), 300);
        }, 5000);
    }

    /**
     * Performance telemetry method for observability.
     * @returns {object}
     */
    getPerformanceStats() {
        const gridStats = this.virtualGrid.getStats();
        return {
            totalMasterImages: this.images.length,
            filteredImages: this.filteredImages.length,
            gridElements: gridStats.total,
            mountedDOMNodes: gridStats.mounted,
            virtualizedPlaceholders: gridStats.virtualized,
            ...this.thumbnails.getStats()
        };
    }

    cleanup() {
        clearTimeout(this._searchDebounceTimer);
        cancelAnimationFrame(this._prefetchFrame);
        this.isAutoScrolling = false;
        this.infiniteScrollObserver?.disconnect();
        this.virtualGrid.destroy();
        this.lightboxController.destroy();
        this.thumbnails.destroy();
    }
}

// Instantiate orchestrator on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    window.gallery = new PhotoGallery();
});

// Service Worker registration (offline PWA)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {
            // SW registration failed; the app still works online
        });
    });
}

// Release object URLs, workers and observers on unload
window.addEventListener('pagehide', (e) => {
    if (!e.persisted) window.gallery?.cleanup();
});
