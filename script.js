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
 *  - FolderStore: remembered folders ("Continue" on the welcome screen).
 */

import {
    loadFavorites,
    toggleFavorite as storageToggleFavorite,
    applyInitialTheme,
    saveTheme,
    loadSort,
    saveSort
} from './modules/StorageService.js';

import {
    processImages,
    collectDroppedFolders,
    collectFilesFromDirectoryHandle,
    isImageFile,
    SkippedFiles
} from './modules/ImageProcessor.js';

import {
    applyFilters,
    sortImages,
    SORT_MODES,
    renderAlbumSelector,
    renderPhotoCount,
    renderFavoritesBadge,
    renderSelectedFolders,
    setupInfiniteScroll
} from './modules/GalleryRenderer.js';

import { VirtualGrid } from './modules/VirtualGrid.js';
import { ThumbnailService } from './modules/ThumbnailService.js';
import { LightboxController } from './modules/LightboxController.js';
import { icon } from './modules/icons.js';
import {
    isFolderMemoryAvailable,
    listFolders,
    rememberFolder,
    forgetFolder,
    getLastSession,
    setLastSession,
    ensureReadPermission
} from './modules/FolderStore.js';

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

        // Multi-folder model:
        // Array<{name, files: File[], selected, handle?: FileSystemDirectoryHandle, storeId?: number}>
        this.selectedFolders = [];

        // Remembered folders (Chrome/Edge)
        this.recentFolders = [];
        this.lastSessionFolders = [];

        // Sort order
        const savedSort = loadSort();
        this.sortMode = SORT_MODES.includes(savedSort) ? savedSort : 'name';

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
                onSlideshowStop: () => this.virtualGrid.setSlideshowActive(null),
                // Keyboard users continue from the photo they were viewing
                onClose: () => this.virtualGrid.focusItem(this.filteredImages[this.currentIndex]?.id)
            }
        );

        this._initEventListeners();
        renderFavoritesBadge(this.favoritesToggle, this.favorites.size);
        this._updateToggleStates();
        if (this.sortSelect) this.sortSelect.value = this.sortMode;
        this.renderRecent();
    }

    // -------------------------------------------------------------------------
    // DOM Initialization
    // -------------------------------------------------------------------------

    _initElements() {
        // Welcome screen
        this.welcomeScreen        = document.getElementById('welcomeScreen');
        this.dropZone             = document.getElementById('dropZone');
        this.folderInput          = document.getElementById('folderInput');
        this.chooseFolderBtn      = document.getElementById('chooseFolderBtn');
        this.recentSection        = document.getElementById('recentSection');
        this.recentList           = document.getElementById('recentList');
        this.continueBtn          = document.getElementById('continueBtn');
        this.continueNames        = document.getElementById('continueNames');
        this.continueMeta         = document.getElementById('continueMeta');
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
        this.sortSelect           = document.getElementById('sortSelect');
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
        this.chooseFolderBtn?.addEventListener('click', () => this.chooseFolder());
        this.continueBtn?.addEventListener('click', () => this.continueLastSession());
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
        this.sortSelect?.addEventListener('change', (e) => this.setSort(e.target.value));
        this.favoritesToggle?.addEventListener('click', () => this.toggleFavoritesView());

        // Lightbox modal buttons
        document.getElementById('closeLightbox')?.addEventListener('click', () => this.lightboxController.close());
        document.getElementById('prevImage')?.addEventListener('click', () => this.lightboxController.navigate(-1));
        document.getElementById('nextImage')?.addEventListener('click', () => this.lightboxController.navigate(1));
        this.downloadBtn?.addEventListener('click', () => this.lightboxController.downloadCurrentImage());
        document.getElementById('lightboxPlayBtn')?.addEventListener('click', () => {
            this.lightboxController.startSlideshow(this.currentIndex);
        });
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

        // Hairline under the top bar once the page is scrolled
        const topbar = document.getElementById('topbar');
        let topbarFrame = 0;
        window.addEventListener('scroll', () => {
            if (topbarFrame) return;
            topbarFrame = requestAnimationFrame(() => {
                topbarFrame = 0;
                topbar?.classList.toggle('is-scrolled', window.scrollY > 4);
            });
        }, { passive: true });

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

    /** Classic folder picker (all browsers). Files carry webkitRelativePath. */
    handleFolderSelection(event) {
        const files = Array.from(event.target.files);
        if (files.length === 0) return;

        const firstPath = files[0].webkitRelativePath || files[0].name;
        const parts = firstPath.split('/');
        const folderName = parts.length > 1 ? parts[0] : 'Selected Folder';

        const skipped = new SkippedFiles();
        const imageFiles = files.filter(f => {
            if (isImageFile(f)) return true;
            skipped.add(f.name);
            return false;
        });
        this.folderInput.value = '';

        if (imageFiles.length === 0) {
            this.showError(this._noPhotosMessage(`“${folderName}”`, skipped));
            return;
        }
        this._addFolder(folderName, imageFiles);
    }

    /** "No photos" message that says what the folder contained instead. */
    _noPhotosMessage(where, skipped) {
        const found = skipped.top(3);
        if (found.length === 0) return `No photos found in ${where}.`;
        const list = found.map(([ext, n]) => `${n} ${ext}`).join(', ');
        const heic = found.some(([ext]) => ext === '.heic' || ext === '.heif');
        return `No supported photos in ${where} (found ${list}).` +
            (heic ? ' HEIC photos need to be converted to JPG first.' : '');
    }

    /**
     * "Choose a folder" uses the classic picker in every browser. Chrome's
     * File System Access picker (showDirectoryPicker) would let us remember
     * the folder, but it refuses Downloads, Desktop, Documents, the user folder
     * and drive roots, and reports that exactly like Cancel. Folders dropped
     * onto the page still come with a handle and are remembered.
     */
    chooseFolder() {
        this.folderInput?.click();
    }

    async _isAlreadyAdded(handle) {
        for (const folder of this.selectedFolders) {
            try {
                if (folder.handle && await folder.handle.isSameEntry(handle)) return folder;
            } catch {
                // ignore stale handles
            }
        }
        return null;
    }

    /** Read a folder handle and add it to the selection. @returns {Promise<boolean>} */
    async _addFolderFromHandle(handle, storeId = null) {
        const existing = await this._isAlreadyAdded(handle);
        if (existing) {
            this.showToast(`“${existing.name}” is already added`);
            return true;
        }

        this.showLoading(true);
        const skipped = new SkippedFiles();
        let files;
        try {
            files = await collectFilesFromDirectoryHandle(handle, skipped);
        } catch (err) {
            console.warn('Could not read folder:', err);
            this.showError(`“${handle.name}” could not be opened. It may have been moved or deleted.`);
            return false;
        } finally {
            this.showLoading(false);
        }

        if (files.length === 0) {
            this.showError(this._noPhotosMessage(`“${handle.name}”`, skipped));
            return false;
        }
        this._addFolder(handle.name, files, handle, storeId);
        return true;
    }

    async handleDroppedFiles(dataTransfer) {
        this.showLoading(true);
        const skipped = new SkippedFiles();
        let folders = [];
        try {
            folders = await collectDroppedFolders(dataTransfer, skipped);
        } catch (err) {
            console.error('Error handling dropped files:', err);
            this.showError('Failed to process dropped files.');
            return;
        } finally {
            this.showLoading(false);
        }

        if (folders.length === 0) {
            this.showError(this._noPhotosMessage('what you dropped', skipped));
            return;
        }
        for (const folder of folders) {
            if (folder.handle && await this._isAlreadyAdded(folder.handle)) {
                this.showToast(`“${folder.name}” is already added`);
                continue;
            }
            this._addFolder(folder.name, folder.files, folder.handle);
        }
    }

    _addFolder(baseName, files, handle = null, storeId = null) {
        const name = this.selectedFolders.some(f => f.name === baseName)
            ? `${baseName} (${this.selectedFolders.length + 1})`
            : baseName;
        this.selectedFolders.push({ name, files, selected: true, handle, storeId });
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

        this.startGalleryBtn?.classList.toggle('hidden', this.selectedFolders.length === 0);

        const label = this.chooseFolderBtn?.querySelector('[data-label]');
        if (label) {
            label.textContent = this.selectedFolders.length > 0 ? 'Add another folder' : 'Choose a folder';
        }
        this._renderRecentList();
    }

    // -------------------------------------------------------------------------
    // Remembered folders (welcome screen)
    // -------------------------------------------------------------------------

    /** Load remembered folders and refresh the "Continue" / "Recent" UI. */
    async renderRecent() {
        if (!this.recentSection || !(await isFolderMemoryAvailable())) return;
        try {
            const [folders, session] = await Promise.all([listFolders(), getLastSession()]);
            this.recentFolders = folders;
            this.lastSessionFolders = session
                .map(id => folders.find(f => f.id === id))
                .filter(Boolean);
        } catch (err) {
            console.warn('Could not read remembered folders:', err);
            return;
        }
        this._renderRecentList();
    }

    _renderRecentList() {
        if (!this.recentSection) return;
        const folders = this.recentFolders;
        this.recentSection.classList.toggle('hidden', folders.length === 0);
        if (folders.length === 0) return;

        // Continue = reopen everything from the last visit in one click
        const session = this.lastSessionFolders;
        this.continueBtn.classList.toggle('hidden', session.length === 0);
        if (session.length > 0) {
            this.continueNames.textContent = session.map(f => f.name).join(', ');
            const total = session.reduce((sum, f) => sum + (f.photoCount || 0), 0);
            this.continueMeta.textContent = total ? `${total} photos` : '';
        }

        const addedIds = new Set(this.selectedFolders.map(f => f.storeId).filter(Boolean));
        this.recentList.replaceChildren();
        for (const folder of folders.slice(0, 6)) {
            const added = addedIds.has(folder.id);

            const row = document.createElement('div');
            row.className = `recent-item${added ? ' is-added' : ''}`;

            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'recent-open';
            open.title = added ? 'Remove from selection' : 'Add to selection';
            open.innerHTML = `${icon(added ? 'check' : 'folder')}<span class="recent-name"></span><span class="recent-count"></span>`;
            open.querySelector('.recent-name').textContent = folder.name;
            open.querySelector('.recent-count').textContent = folder.photoCount ? `${folder.photoCount} photos` : '';
            open.addEventListener('click', () => this.toggleRecent(folder));

            const forget = document.createElement('button');
            forget.type = 'button';
            forget.className = 'recent-forget';
            forget.title = 'Forget this folder';
            forget.setAttribute('aria-label', `Forget ${folder.name}`);
            forget.innerHTML = icon('x');
            forget.addEventListener('click', async () => {
                await forgetFolder(folder.id).catch(() => {});
                this.renderRecent();
            });

            row.append(open, forget);
            this.recentList.appendChild(row);
        }
    }

    /** Click on a recent folder: add it to the selection (or remove it again). */
    async toggleRecent(folder) {
        const index = this.selectedFolders.findIndex(f => f.storeId === folder.id);
        if (index !== -1) {
            this.selectedFolders.splice(index, 1);
            this.renderFolders();
            return;
        }
        if (!(await ensureReadPermission(folder.handle))) {
            this.showToast(`Access to “${folder.name}” was not allowed`);
            return;
        }
        await this._addFolderFromHandle(folder.handle, folder.id);
    }

    /** Reopen the folders from the last visit and go straight to the gallery. */
    async continueLastSession() {
        for (const folder of this.lastSessionFolders) {
            if (this.selectedFolders.some(f => f.storeId === folder.id)) continue;
            // The browser may ask once per folder; each prompt needs its own click
            if (!(await ensureReadPermission(folder.handle))) {
                this.showToast(`Allow access to “${folder.name}” to continue`);
                return;
            }
            if (!(await this._addFolderFromHandle(folder.handle, folder.id))) return;
        }
        if (this.selectedFolders.some(f => f.selected !== false)) this.startGallery();
    }

    /** Remember the opened folders so the next visit can offer "Continue". */
    async _rememberOpenedFolders(folders) {
        if (!(await isFolderMemoryAvailable())) return;
        const withHandles = folders.filter(f => f.handle);
        if (withHandles.length === 0) return;
        try {
            const ids = [];
            for (const folder of withHandles) {
                folder.storeId = await rememberFolder(folder.handle, folder.files.length);
                ids.push(folder.storeId);
            }
            await setLastSession(ids);
        } catch (err) {
            console.warn('Could not remember folders:', err);
        }
    }

    // -------------------------------------------------------------------------
    // Gallery Start & Rendering
    // -------------------------------------------------------------------------

    async startGallery() {
        const activeFolders = this.selectedFolders.filter(f => f.selected !== false);
        const activeFiles = activeFolders.flatMap(f => f.files);

        if (activeFiles.length === 0) return;

        this.showLoading(true);
        this.welcomeScreen.style.display = 'none';
        this.galleryContainer.classList.remove('hidden');

        try {
            this.thumbnails.clear();
            this.images = await processImages(activeFiles, new Map(), (done, total) => {
                this.updateLoadingProgress(done, total);
            });
            this.filteredImages = this._computeFiltered();
            this._rememberOpenedFolders(activeFolders);

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

    setSort(mode) {
        this.sortMode = SORT_MODES.includes(mode) ? mode : 'name';
        saveSort(this.sortMode);
        if (this.images.length > 0) this.applyFilters();
    }

    _computeFiltered() {
        return sortImages(
            applyFilters(this.images, this.currentAlbum, this.showFavoritesOnly, this.favorites, this.searchQuery),
            this.sortMode
        );
    }

    applyFilters() {
        this.filteredImages = this._computeFiltered();

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
            ? `Reading photos… ${done} / ${total}`
            : 'Reading photos…';
    }

    showError(message) {
        console.error('Gallery Error:', message);
        this.showToast(message, 'alert');
    }

    showToast(message, role = 'status') {
        document.querySelectorAll('.toast').forEach(t => t.remove());
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.setAttribute('role', role);
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
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
