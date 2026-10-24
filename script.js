/**
 * script.js
 * Application Orchestrator / Coordinator for Pinterest Photo Gallery.
 *
 * Coordinates:
 *  - StorageService: theme preferences and persistent favorites.
 *  - ImageProcessor: deterministic ID generation, metadata extraction, drag-and-drop ingestion, blob URLs.
 *  - VirtualGrid: viewport-aware DOM windowing, aspect-ratio preservation, blob URL lifecycle management.
 *  - GalleryRenderer: UI component rendering, filter application, folder listing, infinite scroll.
 *  - LightboxController: modal viewer, fullscreen slideshow, touch swipe, keyboard shortcuts.
 */

import {
    loadFavorites,
    saveFavorites,
    toggleFavorite as storageToggleFavorite,
    applyInitialTheme,
    saveTheme,
    loadTheme
} from './modules/StorageService.js';

import {
    generateDeterministicId,
    getOrCreateBlobUrl,
    revokeBlobUrl,
    revokeAllBlobUrls,
    loadImageMetadata,
    processImages,
    collectDroppedImageFiles
} from './modules/ImageProcessor.js';

import {
    escapeHtml,
    formatFileSize,
    applyFilters,
    renderAlbumSelector,
    renderPhotoCount,
    renderFavoritesBadge,
    renderSelectedFolders,
    setupInfiniteScroll
} from './modules/GalleryRenderer.js';

import { VirtualGrid } from './modules/VirtualGrid.js';
import { LightboxController } from './modules/LightboxController.js';

export class PhotoGallery {
    constructor() {
        // Master image records (raw File references; no pre-allocated blob URLs)
        this.images = [];
        this.filteredImages = [];

        // Active blob URL cache: Map<imageId, blobUrl>
        this.activeBlobUrls = new Map();

        // Favorites Set<string>
        this.favorites = loadFavorites();

        // State & pagination
        this.currentIndex = 0;
        this.currentPage = 0;
        this.itemsPerPage = 50;
        this.currentAlbum = 'all';
        this.albums = new Map();
        this.showFavoritesOnly = false;
        this.searchQuery = '';

        // Multi-folder model: Array<{name: string, files: File[], selected: boolean}>
        this.selectedFolders = [];

        // Auto-scroll state
        this.isAutoScrolling = false;
        this.autoScrollSpeed = 1;

        // Initialize DOM elements
        this._initElements();

        // Apply saved or system theme
        applyInitialTheme();

        // Initialize Virtual Grid engine (Phase P2 Windowing)
        this.virtualGrid = new VirtualGrid({
            gridContainer: this.galleryGrid,
            getBlobUrl: (id) => getOrCreateBlobUrl(id, this.activeBlobUrls, this.images),
            revokeBlobUrl: (id) => revokeBlobUrl(id, this.activeBlobUrls),
            onOpenLightbox: (idx) => this.lightboxController.open(idx),
            onStartSlideshow: (idx) => this.lightboxController.startSlideshow(idx),
            onToggleFavorite: (id) => this.toggleFavorite(id),
            isFavorited: (id) => this.favorites.has(id),
            findIndex: (id) => this.filteredImages.findIndex(img => img.id === id),
            getActiveLightboxImageId: () => {
                if (!this.lightboxController?.isOpen) return null;
                const idx = this.lightboxController.getCurrentIndex();
                return (idx >= 0 && idx < this.filteredImages.length)
                    ? this.filteredImages[idx].id
                    : null;
            },
            bufferMargin: '1000px 0px 1000px 0px'
        });

        // Initialize Lightbox Controller
        this.lightboxController = new LightboxController(
            {
                lightbox: this.lightbox,
                lightboxImage: this.lightboxImage,
                lightboxTitle: this.lightboxTitle,
                lightboxInfo: this.lightboxInfo,
                favoriteBtn: this.favoriteBtn,
                downloadBtn: this.downloadBtn,
                slideshowControls: this.slideshowControls,
                slideshowBtn: this.slideshowBtn,
                slideshowIntervalSelect: this.slideshowIntervalSelect,
                autoScrollBtn: this.autoScrollBtn
            },
            {
                getBlobUrl: (id) => getOrCreateBlobUrl(id, this.activeBlobUrls, this.images),
                getFilteredImages: () => this.filteredImages,
                getCurrentIndex: () => this.currentIndex,
                setCurrentIndex: (idx) => {
                    this.currentIndex = idx;
                    this.virtualGrid.setSlideshowActive(this.filteredImages[idx]?.id);
                },
                isFavorited: (id) => this.favorites.has(id),
                onToggleFavorite: (id) => this.toggleFavorite(id),
                onSlideshowIndexChange: () => {
                    this.virtualGrid.setSlideshowActive(this.filteredImages[this.currentIndex]?.id);
                }
            }
        );

        // Bind event listeners
        this._initEventListeners();

        // Initial favorites badge update
        renderFavoritesBadge(this.favoritesToggle, this.favorites.size);
    }

    // -------------------------------------------------------------------------
    // DOM Initialization
    // -------------------------------------------------------------------------

    _initElements() {
        // Welcome screen
        this.welcomeScreen        = document.getElementById('welcomeScreen');
        this.folderInput          = document.getElementById('folderInput');
        this.addFolderBtn         = document.getElementById('addFolderBtn');
        this.startGalleryBtn      = document.getElementById('startGallery');
        this.selectedFoldersList  = document.getElementById('selectedFoldersList');

        // Gallery
        this.galleryContainer     = document.getElementById('galleryContainer');
        this.galleryGrid          = document.getElementById('galleryGrid');
        this.loadingOverlay       = document.getElementById('loadingOverlay');
        this.photoCount           = document.getElementById('photoCount');
        this.noResults            = document.getElementById('noResults');

        // Search & Filters
        this.searchInput          = document.getElementById('searchInput');
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
        this.addFolderBtn?.addEventListener('click', () => this.addCurrentFolder());
        this.startGalleryBtn?.addEventListener('click', () => this.startGallery());

        // Drag & Drop on welcome screen / window
        this._initDragAndDrop();

        // Search & Filter
        this.searchInput?.addEventListener('input', (e) => this.handleSearch(e.target.value));
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
            if (this.currentIndex >= 0 && this.currentIndex < this.filteredImages.length) {
                this.toggleFavorite(this.filteredImages[this.currentIndex].id);
            }
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
        document.addEventListener('keydown', (e) => this.lightboxController.handleKeydown(e));
    }

    _initDragAndDrop() {
        const preventDefaults = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            window.addEventListener(eventName, preventDefaults, false);
        });

        window.addEventListener('drop', async (e) => {
            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
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

        const imageExtensions = /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i;
        const imageFiles = files.filter(f => imageExtensions.test(f.name));

        if (imageFiles.length === 0) {
            this.showError('No supported images found in selected folder.');
            return;
        }

        const firstPath = imageFiles[0].webkitRelativePath || imageFiles[0].name;
        const parts = firstPath.split('/');
        const folderName = parts.length > 1 ? parts[0] : 'Selected Folder';

        this.selectedFolders.push({
            name: folderName,
            files: imageFiles,
            selected: true
        });

        this.folderInput.value = '';
        this.renderFolders();
    }

    addCurrentFolder() {
        this.folderInput?.click();
    }

    async handleDroppedFiles(dataTransfer) {
        this.showLoading(true);
        try {
            const imageFiles = await collectDroppedImageFiles(dataTransfer);
            if (imageFiles.length === 0) {
                this.showError('No supported images found in dropped files or directories.');
                return;
            }

            const firstPath = imageFiles[0].webkitRelativePath || imageFiles[0].name;
            const parts = firstPath.split('/');
            const baseName = parts.length > 1 ? parts[0] : 'Dropped Files';
            const folderName = this.selectedFolders.some(f => f.name === baseName)
                ? `${baseName} (${this.selectedFolders.length + 1})`
                : baseName;

            this.selectedFolders.push({
                name: folderName,
                files: imageFiles,
                selected: true
            });

            this.renderFolders();
        } catch (err) {
            console.error('Error handling dropped files:', err);
            this.showError('Failed to process dropped files.');
        } finally {
            this.showLoading(false);
        }
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
            // Process images and extract metadata (with deterministic IDs)
            this.images = await processImages(activeFiles, this.activeBlobUrls);
            this.filteredImages = [...this.images];

            // Organize albums
            this._organizeAlbums();

            // Render virtual gallery grid
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
        const batch = this.filteredImages.slice(startIndex, endIndex);

        batch.forEach((image, index) => {
            // Staggered reveal for the very first page of items
            const delay = this.currentPage === 0 ? index * 30 : 0;
            this.virtualGrid.appendItem(image, delay);
        });

        this.currentPage++;

        // Setup or reattach infinite scroll
        if (this.currentPage === 1) {
            setupInfiniteScroll(
                this.loadMoreContainer,
                () => this.loadMoreImages(),
                () => this.hasMoreImages()
            );
        }

        // Show/hide no results notice
        this.noResults?.classList.toggle('hidden', this.filteredImages.length > 0);
        this.updatePhotoCount();
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

    handleAlbumChange(album) {
        this.currentAlbum = album;
        this.applyFilters();
    }

    toggleFavoritesView() {
        this.showFavoritesOnly = !this.showFavoritesOnly;
        this.favoritesToggle?.classList.toggle('text-pinterest-red', this.showFavoritesOnly);
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

        this.renderGallery();
        this.updatePhotoCount();
    }

    updatePhotoCount() {
        renderPhotoCount(this.photoCount, this.filteredImages.length, this.favorites.size);
    }

    // -------------------------------------------------------------------------
    // Favorites
    // -------------------------------------------------------------------------

    toggleFavorite(imageId) {
        if (!imageId) return;

        storageToggleFavorite(this.favorites, imageId);
        const isFav = this.favorites.has(imageId);

        // Update virtual grid card if mounted
        this.virtualGrid.updateFavorite(imageId, isFav);

        // Update lightbox favorite button if active
        if (this.lightboxController.isOpen) {
            const currentImg = this.filteredImages[this.currentIndex];
            if (currentImg && currentImg.id === imageId) {
                this.favoriteBtn.innerHTML = `<i class="${isFav ? 'fas' : 'far'} fa-heart"></i>`;
                this.favoriteBtn.classList.toggle('text-red-500', isFav);
            }
        }

        // Update header badge
        renderFavoritesBadge(this.favoritesToggle, this.favorites.size);

        // If in favorites-only view and removed, re-filter
        if (this.showFavoritesOnly && !isFav) {
            this.applyFilters();
        }
    }

    // -------------------------------------------------------------------------
    // Theme & Auto-Scroll
    // -------------------------------------------------------------------------

    toggleDarkMode() {
        const isDark = document.documentElement.classList.toggle('dark');
        saveTheme(isDark ? 'dark' : 'light');
    }

    toggleAutoScroll() {
        this.isAutoScrolling = !this.isAutoScrolling;

        if (this.autoScrollBtn) {
            this.autoScrollBtn.classList.toggle('auto-scrolling', this.isAutoScrolling);
            this.autoScrollBtn.classList.toggle('text-pinterest-red', this.isAutoScrolling);
        }

        if (this.isAutoScrolling) {
            this._autoScrollLoop();
        }
    }

    _autoScrollLoop() {
        if (!this.isAutoScrolling) return;

        window.scrollBy(0, this.autoScrollSpeed);

        const scrollHeight = document.documentElement.scrollHeight;
        const scrollTop = window.scrollY;
        const clientHeight = window.innerHeight;

        if (scrollTop + clientHeight >= scrollHeight - 20) {
            if (this.hasMoreImages()) {
                this.loadMoreImages();
            } else {
                this.isAutoScrolling = false;
                this.autoScrollBtn?.classList.remove('auto-scrolling', 'text-pinterest-red');
                return;
            }
        }

        requestAnimationFrame(() => this._autoScrollLoop());
    }

    // -------------------------------------------------------------------------
    // UI Helpers & Cleanup
    // -------------------------------------------------------------------------

    showLoading(show) {
        this.loadingOverlay?.classList.toggle('hidden', !show);
    }

    showError(message) {
        console.error('Gallery Error:', message);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'fixed top-4 right-4 bg-red-500 text-white px-4 py-2 rounded-lg shadow-lg z-50 transition-opacity';
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
            activeBlobUrls: this.activeBlobUrls.size
        };
    }

    cleanup() {
        revokeAllBlobUrls(this.activeBlobUrls);
        this.virtualGrid.destroy();
        this.lightboxController.destroy();
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
            // SW registration failed, app functions offline via cache
        });
    });
}

// Clean up blob URLs and observers on unload
window.addEventListener('beforeunload', () => {
    window.gallery?.cleanup();
});