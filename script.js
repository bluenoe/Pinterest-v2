// Pinterest-style Photo Gallery Application

// =============================================================================
// FIX 1 (XSS): HTML-escape helper – sanitises all user-controlled strings
// before they are injected into innerHTML or HTML attribute values.
// =============================================================================
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// =============================================================================
// FIX 3 (Deterministic IDs): djb2-based hash over stable file fingerprint
// (name + size + lastModified + path) so the same physical file always maps
// to the same ID across sessions, making localStorage favorites persistent.
// =============================================================================
function generateDeterministicId(file) {
    const raw = `${file.name}|${file.size}|${file.lastModified}|${file.webkitRelativePath || ''}`;
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
        hash = ((hash << 5) + hash) ^ raw.charCodeAt(i);
        hash = hash & hash; // coerce to 32-bit integer
    }
    return 'img_' + (hash >>> 0).toString(16); // unsigned hex
}

class PhotoGallery {
    constructor() {
        this.images = [];
        this.filteredImages = [];
        this.favorites = new Set(JSON.parse(localStorage.getItem('gallery-favorites') || '[]'));
        this.currentIndex = 0;
        this.currentPage = 0;
        this.itemsPerPage = 50;
        this.isLightboxOpen = false;
        this.isSlideshow = false;
        this.slideshowTimer = null; // Timer ID for slideshow
        this.slideshowSpeed = 3000;
        this.showFavoritesOnly = false;
        this.currentAlbum = 'all';
        this.albums = new Map();
        this.selectedFolders = []; // Array of {name: string, files: File[], selected: boolean}
        this.lazyLoadObserver = null;
        this.infiniteScrollObserver = null;
        this.isAutoScrolling = false;
        this.autoScrollSpeed = 1; // pixels per frame

        // FIX 2 (Memory): Map<imageId, blobUrl> for controlled, on-demand lifecycle.
        // Blob URLs are created only when items enter the viewport or lightbox.
        this.activeBlobUrls = new Map();

        this.initializeElements();
        this.initializeEventListeners();
        this.initializeDarkMode();
        this.initializeLazyLoading();
        this.initializeTouchSwipe();

        // Initialize favorites display on startup
        this.updateFavoritesToggle();

        console.log('Favorites loaded from storage:', this.favorites.size, 'items');
    }

    initializeElements() {
        // Welcome screen elements
        this.welcomeScreen = document.getElementById('welcomeScreen');
        this.folderInput = document.getElementById('folderInput');
        this.startGalleryBtn = document.getElementById('startGallery');
        this.addFolderBtn = document.getElementById('addFolderBtn');
        this.selectedFoldersList = document.getElementById('selectedFoldersList');

        // Gallery container elements
        this.galleryContainer = document.getElementById('galleryContainer');
        this.galleryGrid = document.getElementById('galleryGrid');
        this.loadingOverlay = document.getElementById('loadingOverlay');
        this.photoCount = document.getElementById('photoCount');
        this.noResults = document.getElementById('noResults');

        // Search and filter elements
        this.searchInput = document.getElementById('searchInput');
        this.albumSelector = document.getElementById('albumSelector');
        this.albumSelect = document.getElementById('albumSelect');
        this.favoritesToggle = document.getElementById('favoritesToggle');

        // Lightbox elements
        this.lightbox = document.getElementById('lightbox');
        this.lightboxImage = document.getElementById('lightboxImage');
        this.lightboxTitle = document.getElementById('lightboxTitle');
        this.lightboxInfo = document.getElementById('lightboxInfo');
        this.favoriteBtn = document.getElementById('favoriteBtn');
        this.downloadBtn = document.getElementById('downloadBtn');

        // Control elements
        this.darkModeToggle = document.getElementById('darkModeToggle');
        this.slideshowBtn = document.getElementById('slideshowBtn');
        this.loadMoreBtn = document.getElementById('loadMoreBtn');
        this.loadMoreContainer = document.getElementById('loadMoreContainer');

        // Slideshow elements
        this.slideshowControls = document.getElementById('slideshowControls');
        this.slideshowIntervalSelect = document.getElementById('slideshowInterval');
        this.autoScrollBtn = document.getElementById('autoScrollBtn');
    }

    initializeEventListeners() {
        // Welcome screen events
        this.folderInput.addEventListener('change', (e) => this.handleFolderSelection(e));
        this.addFolderBtn.addEventListener('click', () => this.addCurrentFolder());
        this.startGalleryBtn.addEventListener('click', () => this.startGallery());

        // Search and filter events
        this.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        this.albumSelect.addEventListener('change', (e) => this.handleAlbumChange(e.target.value));
        this.favoritesToggle.addEventListener('click', () => this.toggleFavoritesView());

        // Lightbox events
        document.getElementById('closeLightbox').addEventListener('click', () => this.closeLightbox());
        document.getElementById('prevImage').addEventListener('click', () => this.navigateImage(-1));
        document.getElementById('nextImage').addEventListener('click', () => this.navigateImage(1));

        // Lightbox favorite button with error handling
        this.favoriteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleFavorite();
        });

        this.downloadBtn.addEventListener('click', () => this.downloadImage());

        // Theme and slideshow events
        this.darkModeToggle.addEventListener('click', () => this.toggleDarkMode());
        this.slideshowBtn.addEventListener('click', () => this.startSlideshow());

        // Auto scroll button
        if (this.autoScrollBtn) {
            this.autoScrollBtn.addEventListener('click', () => this.toggleAutoScroll());
        }

        // Slideshow control events
        document.getElementById('slideshowPlayPauseBtn').addEventListener('click', () => this.toggleSlideshowPlayPause());
        document.getElementById('slideshowPrevBtn').addEventListener('click', () => this.navigateImage(-1));
        document.getElementById('slideshowNextBtn').addEventListener('click', () => this.navigateImage(1));
        document.getElementById('slideshowStopBtn').addEventListener('click', () => this.stopSlideshow());
        this.slideshowIntervalSelect.addEventListener('change', (e) => {
            this.slideshowSpeed = parseInt(e.target.value);
            if (this.isSlideshow) {
                this.restartSlideshowTimer();
            }
        });

        // Keyboard events
        document.addEventListener('keydown', (e) => this.handleKeydown(e));

        // Click outside lightbox to close
        this.lightbox.addEventListener('click', (e) => {
            if (e.target === this.lightbox) {
                this.closeLightbox();
            }
        });

        // Drag and drop support
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        // FIX 4 (Drag & Drop): pass the full DataTransfer object so we can
        // access items (with webkitGetAsEntry for directory traversal) as well
        // as the fallback FileList.
        document.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.handleDroppedFiles(e.dataTransfer);
        });
    }

    initializeDarkMode() {
        const savedTheme = localStorage.getItem('gallery-theme');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

        if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
            document.documentElement.classList.add('dark');
        }
    }

    // FIX 2 (Memory): Blob URLs are created on demand when an item scrolls
    // into the viewport, not upfront during gallery construction.
    initializeLazyLoading() {
        this.lazyLoadObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    const imageId = img.dataset.fileId;
                    if (!imageId) return;

                    // Allocate (or reuse cached) blob URL on demand
                    const blobUrl = this.getOrCreateBlobUrl(imageId);
                    if (!blobUrl) return;

                    const tempImg = new Image();
                    tempImg.onload = () => {
                        img.src = blobUrl;
                        img.removeAttribute('data-file-id');
                        img.classList.remove('loading-skeleton');
                        img.classList.add('lazy-loaded');
                    };
                    tempImg.src = blobUrl;
                    this.lazyLoadObserver.unobserve(img);
                }
            });
        }, { rootMargin: '200px' }); // Preload earlier for smoother experience
    }

    // FIX 2: Central blob-URL factory. Creates a URL once per image per session
    // and caches it in activeBlobUrls.
    getOrCreateBlobUrl(imageId) {
        if (this.activeBlobUrls.has(imageId)) {
            return this.activeBlobUrls.get(imageId);
        }
        const image = this.images.find(img => img.id === imageId);
        if (!image || !image.file) return null;
        const url = URL.createObjectURL(image.file);
        this.activeBlobUrls.set(imageId, url);
        return url;
    }

    // Revoke one cached blob URL
    revokeBlobUrl(imageId) {
        const url = this.activeBlobUrls.get(imageId);
        if (url) {
            URL.revokeObjectURL(url);
            this.activeBlobUrls.delete(imageId);
        }
    }

    // Revoke all active blob URLs (gallery reset or page unload)
    revokeAllBlobUrls() {
        this.activeBlobUrls.forEach(url => URL.revokeObjectURL(url));
        this.activeBlobUrls.clear();
    }

    async handleFolderSelection(event) {
        const files = Array.from(event.target.files);
        if (files.length > 0) {
            // Store temporarily for adding
            this.pendingFiles = files;
            // Auto-add if no folders yet, otherwise user clicks Add button
            if (this.selectedFolders.length === 0) {
                this.addCurrentFolder();
            } else {
                // Show hint that they can click Add
                this.addFolderBtn.classList.add('ring-2', 'ring-pinterest-red');
                setTimeout(() => this.addFolderBtn.classList.remove('ring-2', 'ring-pinterest-red'), 2000);
            }
        }
    }

    addCurrentFolder() {
        const files = this.pendingFiles || Array.from(this.folderInput.files);
        if (!files || files.length === 0) return;

        // Get folder name from path
        const firstFile = files[0];
        const pathParts = firstFile.webkitRelativePath ? firstFile.webkitRelativePath.split('/') : [];
        const folderName = pathParts.length > 0 ? pathParts[0] : 'Folder ' + (this.selectedFolders.length + 1);

        // Check if folder already added
        if (this.selectedFolders.some(f => f.name === folderName)) {
            this.showError(`Folder "${folderName}" has already been added.`);
            return;
        }

        // Add to selected folders
        this.selectedFolders.push({
            name: folderName,
            files: files
        });

        // Clear pending and input
        this.pendingFiles = null;
        this.folderInput.value = '';

        // Update UI
        this.renderSelectedFolders();
    }

    renderSelectedFolders() {
        const selectedCount = this.selectedFolders.filter(f => f.selected !== false).length;
        const totalSelectedFiles = this.selectedFolders
            .filter(f => f.selected !== false)
            .reduce((sum, f) => sum + f.files.length, 0);

        // Update button state
        if (this.selectedFolders.length > 0 && selectedCount > 0) {
            this.startGalleryBtn.disabled = false;
            this.startGalleryBtn.textContent = `Explore ${totalSelectedFiles} files from ${selectedCount} folder${selectedCount > 1 ? 's' : ''}`;
        } else {
            this.startGalleryBtn.disabled = true;
            this.startGalleryBtn.textContent = this.selectedFolders.length > 0 ? 'Select at least one folder' : 'Start Exploring';
        }

        // Static controls HTML (no user data – safe to use innerHTML)
        let controlsHTML = '';
        if (this.selectedFolders.length > 1) {
            controlsHTML = `
                <div class="folder-selection-controls">
                    <button onclick="gallery.selectAllFolders()" class="folder-selection-btn">
                        <i class="fas fa-check-double mr-1"></i>Select All
                    </button>
                    <button onclick="gallery.deselectAllFolders()" class="folder-selection-btn">
                        <i class="fas fa-times mr-1"></i>Deselect All
                    </button>
                </div>
            `;
        }

        // FIX 1 (XSS): Build folder items via DOM construction so folder.name
        // is always set through textContent, never interpolated into innerHTML.
        this.selectedFoldersList.innerHTML = controlsHTML;

        this.selectedFolders.forEach((folder, index) => {
            const isSelected = folder.selected !== false;

            const folderItem = document.createElement('div');
            folderItem.className = `folder-item ${isSelected ? 'selected' : ''}`;
            folderItem.addEventListener('click', () => this.toggleFolderSelection(index));

            // Static structural HTML – no user data injected here
            folderItem.innerHTML = `
                <div class="folder-info">
                    <div class="folder-checkbox ${isSelected ? 'checked' : ''}">
                        ${isSelected ? '<i class="fas fa-check"></i>' : ''}
                    </div>
                    <i class="fas fa-folder text-pinterest-red"></i>
                    <span class="folder-name"></span>
                    <span class="folder-count"></span>
                </div>
                <div class="folder-actions">
                    <button class="folder-remove-btn" title="Remove folder">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `;

            // Safe assignment of user-controlled text
            folderItem.querySelector('.folder-name').textContent = folder.name;
            folderItem.querySelector('.folder-count').textContent = `(${folder.files.length} files)`;
            folderItem.querySelector('.folder-remove-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeFolder(index);
            });

            this.selectedFoldersList.appendChild(folderItem);
        });
    }

    toggleFolderSelection(index) {
        if (index >= 0 && index < this.selectedFolders.length) {
            const folder = this.selectedFolders[index];
            folder.selected = folder.selected === false ? true : false;
            this.renderSelectedFolders();
        }
    }

    selectAllFolders() {
        this.selectedFolders.forEach(folder => folder.selected = true);
        this.renderSelectedFolders();
    }

    deselectAllFolders() {
        this.selectedFolders.forEach(folder => folder.selected = false);
        this.renderSelectedFolders();
    }

    removeFolder(index) {
        this.selectedFolders.splice(index, 1);
        this.renderSelectedFolders();
    }

    // FIX 4 (Drag & Drop): Accept the full DataTransfer object so we can use
    // webkitGetAsEntry() for recursive directory traversal. Dropped files are
    // normalised into the same selectedFolders model that startGallery() reads,
    // so both the directory picker and drag-and-drop share the same pipeline.
    async handleDroppedFiles(dataTransfer) {
        const imageExtensions = /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i;
        const allFiles = [];

        if (dataTransfer.items && dataTransfer.items.length > 0) {
            const entries = [];
            for (const item of dataTransfer.items) {
                if (item.kind === 'file') {
                    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                    if (entry) {
                        entries.push(entry);
                    } else {
                        const file = item.getAsFile();
                        if (file) allFiles.push(file);
                    }
                }
            }
            for (const entry of entries) {
                await this.collectFilesFromEntry(entry, allFiles);
            }
        } else {
            // Fallback for older browsers
            for (const file of dataTransfer.files) allFiles.push(file);
        }

        const imageFiles = allFiles.filter(f =>
            f.type.startsWith('image/') || imageExtensions.test(f.name)
        );

        if (imageFiles.length === 0) {
            this.showError('No supported image files found in the dropped items.');
            return;
        }

        // Derive a folder name from the first file's path (best-effort)
        const firstPath = imageFiles[0].webkitRelativePath || imageFiles[0].name;
        const parts = firstPath.split('/');
        const baseName = parts.length > 1 ? parts[0] : 'Dropped Files';
        const folderName = this.selectedFolders.some(f => f.name === baseName)
            ? `${baseName} (${Date.now()})`
            : baseName;

        // Normalise into the shared selectedFolders model
        this.selectedFolders.push({
            name: folderName,
            files: imageFiles,
            selected: true
        });

        this.renderSelectedFolders();
    }

    // Recursively walk a FileSystemEntry tree and collect all File objects
    collectFilesFromEntry(entry, result) {
        return new Promise((resolve) => {
            if (entry.isFile) {
                entry.file(file => { result.push(file); resolve(); }, () => resolve());
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                const readBatch = () => {
                    reader.readEntries(async (entries) => {
                        if (entries.length === 0) {
                            resolve();
                        } else {
                            for (const e of entries) {
                                await this.collectFilesFromEntry(e, result);
                            }
                            readBatch(); // readEntries may return partial batches
                        }
                    }, () => resolve());
                };
                readBatch();
            } else {
                resolve();
            }
        });
    }

    async startGallery() {
        if (!this.selectedFolders || this.selectedFolders.length === 0) return;

        // Combine files only from selected (checked) folders
        const allFiles = this.selectedFolders
            .filter(folder => folder.selected !== false)
            .flatMap(folder => folder.files);
        if (allFiles.length === 0) return;

        this.showLoading(true);
        this.welcomeScreen.style.display = 'none';
        this.galleryContainer.classList.remove('hidden');

        try {
            await this.processImages(allFiles);
            this.organizeAlbums();
            this.renderGallery();
            this.updatePhotoCount();
            // Initialize favorites display after gallery loads
            this.updateFavoritesToggle();
        } catch (error) {
            console.error('Error starting gallery:', error);
            this.showError('Failed to load images. Please try again.');
        } finally {
            this.showLoading(false);
        }
    }

    // FIX 2 (Memory) + FIX 3 (IDs): No eager blob URL allocation.
    // Stores the raw File reference; blob URLs are created on demand.
    async processImages(files) {
        const imageExtensions = /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i;
        const imageFiles = files.filter(file => imageExtensions.test(file.name));

        // Revoke any URLs from a previous gallery load before rebuilding
        this.revokeAllBlobUrls();
        this.images = [];

        for (const file of imageFiles) {
            try {
                const image = await this.loadImageMetadata(file);
                this.images.push(image);
            } catch (error) {
                console.warn('Failed to process image:', file.name, error);
            }
        }

        // Sort images by name
        this.images.sort((a, b) => a.name.localeCompare(b.name));
        this.filteredImages = [...this.images];
    }

    // FIX 2 + FIX 3: Short-lived temp URL for dimension detection; immediately
    // revoked after metadata is captured. ID is now deterministic.
    async loadImageMetadata(file) {
        return new Promise((resolve, reject) => {
            const tempUrl = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(tempUrl); // Release immediately after decode

                const pathParts = file.webkitRelativePath ? file.webkitRelativePath.split('/') : [file.name];
                const album = pathParts.length > 1 ? pathParts[pathParts.length - 2] : 'Main';

                resolve({
                    id: generateDeterministicId(file), // FIX 3: stable, session-persistent ID
                    name: file.name,
                    file: file,       // Raw File reference; blob URL allocated on demand
                    path: file.webkitRelativePath || file.name,
                    album: album,
                    width: img.naturalWidth  || img.width,
                    height: img.naturalHeight || img.height,
                    size: file.size,
                    lastModified: file.lastModified,
                    type: file.type
                });
            };
            img.onerror = () => {
                URL.revokeObjectURL(tempUrl);
                reject(new Error(`Failed to load image: ${file.name}`));
            };
            img.src = tempUrl;
        });
    }

    organizeAlbums() {
        this.albums.clear();
        this.albums.set('all', this.images);

        this.images.forEach(image => {
            if (!this.albums.has(image.album)) {
                this.albums.set(image.album, []);
            }
            this.albums.get(image.album).push(image);
        });

        // Update album selector
        this.albumSelect.innerHTML = '<option value="all">All Photos</option>';
        for (const [albumName, images] of this.albums) {
            if (albumName !== 'all') {
                const option = document.createElement('option');
                option.value = albumName;
                option.textContent = `${albumName} (${images.length})`;
                this.albumSelect.appendChild(option);
            }
        }

        this.albumSelector.classList.toggle('hidden', this.albums.size <= 2);
    }

    renderGallery() {
        this.currentPage = 0;
        this.galleryGrid.innerHTML = '';
        this.loadMoreImages();
    }

    loadMoreImages() {
        const startIndex = this.currentPage * this.itemsPerPage;
        const endIndex = Math.min(startIndex + this.itemsPerPage, this.filteredImages.length);
        const imagesToLoad = this.filteredImages.slice(startIndex, endIndex);

        imagesToLoad.forEach((image, index) => {
            setTimeout(() => {
                this.createGalleryItem(image);
            }, index * 50); // Staggered loading for animation effect
        });

        this.currentPage++;

        // Setup infinite scroll observer after first load
        if (this.currentPage === 1) {
            this.setupInfiniteScroll();
        }

        // Show no results message if no images
        this.noResults.classList.toggle('hidden', this.filteredImages.length > 0);
    }

    setupInfiniteScroll() {
        // Disconnect existing observer
        if (this.infiniteScrollObserver) {
            this.infiniteScrollObserver.disconnect();
        }

        // Create sentinel element for infinite scroll
        let sentinel = document.getElementById('infiniteScrollSentinel');
        if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.id = 'infiniteScrollSentinel';
            sentinel.style.height = '1px';
            this.loadMoreContainer.parentNode.insertBefore(sentinel, this.loadMoreContainer);
        }

        // Hide load more button
        this.loadMoreContainer.classList.add('hidden');

        this.infiniteScrollObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const hasMore = this.currentPage * this.itemsPerPage < this.filteredImages.length;
                    if (hasMore) {
                        this.loadMoreImages();
                    }
                }
            });
        }, { rootMargin: '200px' });

        this.infiniteScrollObserver.observe(sentinel);
    }

    // FIX 1 (XSS) + FIX 2 (Memory):
    //  – User text (name, meta) set via textContent, never interpolated into innerHTML.
    //  – <img> carries data-file-id instead of a pre-allocated blob URL; the
    //    IntersectionObserver calls getOrCreateBlobUrl() when item enters viewport.
    createGalleryItem(image) {
        const isFavorited = this.favorites.has(image.id);
        const aspectRatio = (image.height / image.width * 100).toFixed(2);

        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.dataset.imageId = image.id;

        // Static structural HTML – image.id is a hex hash (safe), no user text here
        item.innerHTML = `
            <div class="image-wrapper" style="padding-bottom: ${aspectRatio}%;">
                <img data-file-id="${escapeHtml(image.id)}"
                     alt=""
                     class="loading-skeleton lazy-image">
            </div>
            <div class="gallery-item-overlay">
                <div class="gallery-item-info">
                    <div class="gallery-item-title"></div>
                    <div class="gallery-item-meta"></div>
                </div>
            </div>
            <div class="gallery-item-actions">
                <button class="gallery-action-btn slideshow-btn" title="Start slideshow from here">
                    <i class="fas fa-play"></i>
                </button>
                <button class="gallery-action-btn favorite-btn ${isFavorited ? 'favorited' : ''}"
                        data-image-id="${escapeHtml(image.id)}"
                        title="${isFavorited ? 'Remove from favorites' : 'Add to favorites'}">
                    <i class="${isFavorited ? 'fas' : 'far'} fa-heart"></i>
                </button>
            </div>
        `;

        // FIX 1: Set user-controlled text safely via textContent
        item.querySelector('.gallery-item-title').textContent = image.name;
        item.querySelector('.gallery-item-meta').textContent =
            `${this.formatFileSize(image.size)} • ${image.width}×${image.height}`;
        item.querySelector('img').alt = image.name;

        // Click → open lightbox
        item.addEventListener('click', (e) => {
            if (!e.target.closest('.gallery-action-btn')) {
                const correctIndex = this.filteredImages.findIndex(img => img.id === image.id);
                if (correctIndex !== -1) this.openLightbox(correctIndex);
            }
        });

        // Slideshow button
        const slideshowBtn = item.querySelector('.slideshow-btn');
        if (slideshowBtn) {
            slideshowBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const imageIndex = this.filteredImages.findIndex(img => img.id === image.id);
                if (imageIndex !== -1) this.startSlideshowFromIndex(imageIndex);
            });
        }

        // Favorite button
        const favoriteBtn = item.querySelector('.favorite-btn');
        if (favoriteBtn) {
            favoriteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                try {
                    this.toggleImageFavorite(image.id);
                } catch (error) {
                    console.error('Error in favorite button click:', error);
                }
            });
        }

        this.galleryGrid.appendChild(item);

        // FIX 2: Register for lazy-load; blob URL allocated only on viewport entry
        const img = item.querySelector('img');
        if (img) this.lazyLoadObserver.observe(img);
    }

    openLightbox(index) {
        this.currentIndex = index;
        this.isLightboxOpen = true;
        this.lightbox.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        this.updateLightboxImage();
    }

    closeLightbox() {
        this.isLightboxOpen = false;
        this.lightbox.classList.add('hidden');
        document.body.style.overflow = '';

        // Disable fullscreen slideshow mode
        const contentContainer = document.querySelector('.lightbox-content-container');
        if (contentContainer) {
            contentContainer.classList.remove('slideshow-mode');
        }

        // Remove slideshow mode class from lightbox
        if (this.lightbox) {
            this.lightbox.classList.remove('slideshow-mode');
        }

        if (this.isSlideshow) {
            this.stopSlideshow();
        }
    }

    // FIX 1 (XSS): title and info set via textContent.
    // FIX 2 (Memory): blob URL resolved on demand via getOrCreateBlobUrl().
    updateLightboxImage() {
        if (this.currentIndex < 0 || this.currentIndex >= this.filteredImages.length) return;

        const image = this.filteredImages[this.currentIndex];

        // Show loading state
        this.lightboxImage.classList.add('loading');
        this.lightboxImage.style.opacity = '0.5';

        // FIX 2: Allocate (or reuse cached) blob URL on demand
        const blobUrl = this.getOrCreateBlobUrl(image.id);

        const preloadImg = new Image();
        preloadImg.onload = () => {
            this.lightboxImage.src = blobUrl;
            this.lightboxImage.classList.remove('loading');
            this.lightboxImage.style.opacity = '1';
        };
        preloadImg.onerror = () => {
            this.lightboxImage.classList.remove('loading');
            this.lightboxImage.style.opacity = '1';
        };
        preloadImg.src = blobUrl;

        // FIX 1 (XSS): user-supplied strings via textContent only
        this.lightboxTitle.textContent = image.name;
        this.lightboxInfo.textContent =
            `${this.formatFileSize(image.size)} • ${image.width}×${image.height} • ${image.album}`;

        // Favorite button icon-only innerHTML is safe (no user data)
        const isFavorited = this.favorites.has(image.id);
        this.favoriteBtn.innerHTML = `<i class="${isFavorited ? 'fas' : 'far'} fa-heart"></i>`;
        this.favoriteBtn.classList.toggle('text-red-500', isFavorited);

        // Update slideshow active indicator
        document.querySelectorAll('.gallery-item').forEach((item, index) => {
            item.classList.toggle('slideshow-active', this.isSlideshow && index === this.currentIndex);
        });
    }

    // Touch swipe support for mobile
    initializeTouchSwipe() {
        let touchStartX = 0;
        let touchEndX = 0;
        const minSwipeDistance = 50;

        this.lightbox.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });

        this.lightbox.addEventListener('touchend', (e) => {
            touchEndX = e.changedTouches[0].screenX;
            const swipeDistance = touchEndX - touchStartX;

            if (Math.abs(swipeDistance) > minSwipeDistance) {
                if (swipeDistance > 0) {
                    this.navigateImage(-1); // Swipe right = previous
                } else {
                    this.navigateImage(1); // Swipe left = next
                }
            }
        }, { passive: true });
    }

    navigateImage(direction) {
        this.currentIndex += direction;

        if (this.currentIndex < 0) {
            this.currentIndex = this.filteredImages.length - 1;
        } else if (this.currentIndex >= this.filteredImages.length) {
            this.currentIndex = 0;
        }

        this.updateLightboxImage();
    }

    toggleFavorite() {
        try {
            if (this.currentIndex >= 0 && this.currentIndex < this.filteredImages.length) {
                const image = this.filteredImages[this.currentIndex];
                if (image && image.id) {
                    this.toggleImageFavorite(image.id);
                    this.updateLightboxImage();
                } else {
                    console.warn('toggleFavorite: Invalid image data');
                }
            } else {
                console.warn('toggleFavorite: Invalid current index');
            }
        } catch (error) {
            console.error('Error in toggleFavorite:', error);
            this.showError('Failed to toggle favorite. Please try again.');
        }
    }

    toggleImageFavorite(imageId) {
        try {
            if (!imageId) {
                console.warn('toggleImageFavorite: Invalid imageId provided');
                return;
            }

            if (this.favorites.has(imageId)) {
                this.favorites.delete(imageId);
            } else {
                this.favorites.add(imageId);
            }

            // Update localStorage
            localStorage.setItem('gallery-favorites', JSON.stringify([...this.favorites]));

            // Update UI for gallery items
            document.querySelectorAll(`[data-image-id="${imageId}"]`).forEach(btn => {
                const isFavorited = this.favorites.has(imageId);
                btn.classList.toggle('favorited', isFavorited);
                btn.innerHTML = `<i class="${isFavorited ? 'fas' : 'far'} fa-heart"></i>`;
            });

            // Update lightbox favorite button if lightbox is open
            if (this.isLightboxOpen && this.favoriteBtn) {
                const currentImage = this.filteredImages[this.currentIndex];
                if (currentImage && currentImage.id === imageId) {
                    const isFavorited = this.favorites.has(imageId);
                    this.favoriteBtn.innerHTML = `<i class="${isFavorited ? 'fas' : 'far'} fa-heart"></i>`;
                    this.favoriteBtn.classList.toggle('text-red-500', isFavorited);
                }
            }

            // Update favorites toggle badge
            this.updateFavoritesToggle();

            // Update photo count display
            this.updatePhotoCount();

            // Refresh gallery if showing favorites only
            if (this.showFavoritesOnly) {
                this.applyFilters();
            }
        } catch (error) {
            console.error('Error toggling favorite:', error);
            this.showError('Failed to update favorite. Please try again.');
        }
    }

    // FIX 2 (Memory): obtain blob URL on demand; kept in activeBlobUrls cache
    // so the browser can serve the download and it is cleaned up on gallery reset.
    downloadImage() {
        if (this.currentIndex >= 0 && this.currentIndex < this.filteredImages.length) {
            const image = this.filteredImages[this.currentIndex];
            const blobUrl = this.getOrCreateBlobUrl(image.id);
            if (!blobUrl) return;

            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = image.name; // safe – sets attribute value, not HTML
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }

    startSlideshow() {
        this.startSlideshowFromIndex(0);
    }

    startSlideshowFromIndex(startIndex) {
        if (this.filteredImages.length === 0) return;

        // Validate and clamp index
        const validIndex = Math.max(0, Math.min(startIndex, this.filteredImages.length - 1));

        if (!this.isLightboxOpen) {
            this.openLightbox(validIndex);
        } else {
            this.currentIndex = validIndex;
            this.updateLightboxImage();
        }

        this.isSlideshow = true;
        this.slideshowControls.classList.remove('hidden');
        this.slideshowBtn.innerHTML = '<i class="fas fa-stop"></i>';

        // Enable fullscreen slideshow mode
        const contentContainer = document.querySelector('.lightbox-content-container');
        if (contentContainer) {
            contentContainer.classList.add('slideshow-mode');
        }

        // Add slideshow mode class to lightbox
        this.lightbox.classList.add('slideshow-mode');

        this.restartSlideshowTimer();

        // Update play/pause button
        document.getElementById('slideshowPlayPauseBtn').innerHTML = '<i class="fas fa-pause"></i>';
    }

    stopSlideshow() {
        this.isSlideshow = false;
        this.slideshowControls.classList.add('hidden');
        this.slideshowBtn.innerHTML = '<i class="fas fa-play"></i>';

        // Disable fullscreen slideshow mode
        const contentContainer = document.querySelector('.lightbox-content-container');
        if (contentContainer) {
            contentContainer.classList.remove('slideshow-mode');
        }

        // Remove slideshow mode class from lightbox
        if (this.lightbox) {
            this.lightbox.classList.remove('slideshow-mode');
        }

        if (this.slideshowTimer) {
            clearInterval(this.slideshowTimer);
            this.slideshowTimer = null;
        }

        // Remove active indicators
        document.querySelectorAll('.slideshow-active').forEach(item => {
            item.classList.remove('slideshow-active');
        });
    }

    toggleSlideshowPlayPause() {
        if (this.slideshowTimer) {
            clearInterval(this.slideshowTimer);
            this.slideshowTimer = null;
            document.getElementById('slideshowPlayPauseBtn').innerHTML = '<i class="fas fa-play"></i>';
        } else {
            this.restartSlideshowTimer();
            document.getElementById('slideshowPlayPauseBtn').innerHTML = '<i class="fas fa-pause"></i>';
        }
    }

    restartSlideshowTimer() {
        if (this.slideshowTimer) {
            clearInterval(this.slideshowTimer);
        }

        this.slideshowTimer = setInterval(() => {
            this.navigateImage(1);
        }, this.slideshowSpeed);
    }

    handleSearch(query) {
        this.searchQuery = query.toLowerCase();
        this.applyFilters();
    }

    handleAlbumChange(album) {
        this.currentAlbum = album;
        this.applyFilters();
    }

    toggleFavoritesView() {
        this.showFavoritesOnly = !this.showFavoritesOnly;
        this.favoritesToggle.classList.toggle('text-pinterest-red', this.showFavoritesOnly);
        this.applyFilters();
    }

    applyFilters() {
        let filtered = this.images;

        // Filter by album
        if (this.currentAlbum !== 'all') {
            filtered = filtered.filter(img => img.album === this.currentAlbum);
        }

        // Filter by favorites
        if (this.showFavoritesOnly) {
            filtered = filtered.filter(img => this.favorites.has(img.id));
        }

        // Filter by search query
        if (this.searchQuery) {
            filtered = filtered.filter(img =>
                img.name.toLowerCase().includes(this.searchQuery) ||
                img.album.toLowerCase().includes(this.searchQuery)
            );
        }

        this.filteredImages = filtered;
        this.renderGallery();
        this.updatePhotoCount();
    }

    updatePhotoCount() {
        const total = this.filteredImages.length;
        const favorites = this.favorites.size;

        let text = `${total} photo${total !== 1 ? 's' : ''}`;
        if (favorites > 0) {
            text += ` • ${favorites} favorite${favorites !== 1 ? 's' : ''}`;
        }

        this.photoCount.textContent = text;
    }

    updateFavoritesToggle() {
        try {
            // Ensure favoritesToggle element exists
            if (!this.favoritesToggle) {
                console.warn('favoritesToggle element not found');
                return;
            }

            const count = this.favorites.size;
            if (count > 0) {
                if (!this.favoritesToggle.querySelector('.favorites-badge')) {
                    const badge = document.createElement('span');
                    badge.className = 'favorites-badge';
                    badge.textContent = count;
                    this.favoritesToggle.appendChild(badge);
                } else {
                    this.favoritesToggle.querySelector('.favorites-badge').textContent = count;
                }
            } else {
                const badge = this.favoritesToggle.querySelector('.favorites-badge');
                if (badge) badge.remove();
            }
        } catch (error) {
            console.error('Error updating favorites toggle:', error);
        }
    }

    toggleDarkMode() {
        const isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('gallery-theme', isDark ? 'dark' : 'light');
    }

    toggleAutoScroll() {
        this.isAutoScrolling = !this.isAutoScrolling;

        if (this.autoScrollBtn) {
            this.autoScrollBtn.classList.toggle('auto-scrolling', this.isAutoScrolling);
            this.autoScrollBtn.classList.toggle('text-pinterest-red', this.isAutoScrolling);
        }

        if (this.isAutoScrolling) {
            this.autoScrollLoop();
        }
    }

    autoScrollLoop() {
        if (!this.isAutoScrolling) return;

        window.scrollBy(0, this.autoScrollSpeed);

        // Check if reached bottom
        const scrollHeight = document.documentElement.scrollHeight;
        const scrollTop = window.scrollY;
        const clientHeight = window.innerHeight;

        if (scrollTop + clientHeight >= scrollHeight - 10) {
            // At bottom, check if more images to load
            const hasMore = this.currentPage * this.itemsPerPage < this.filteredImages.length;
            if (!hasMore) {
                // No more images, stop auto scroll
                this.isAutoScrolling = false;
                if (this.autoScrollBtn) {
                    this.autoScrollBtn.classList.remove('auto-scrolling', 'text-pinterest-red');
                }
                return;
            }
        }

        requestAnimationFrame(() => this.autoScrollLoop());
    }

    handleKeydown(event) {
        if (!this.isLightboxOpen) return;

        switch (event.key) {
            case 'Escape':
                this.closeLightbox();
                break;
            case 'ArrowLeft':
                event.preventDefault();
                this.navigateImage(-1);
                break;
            case 'ArrowRight':
                event.preventDefault();
                this.navigateImage(1);
                break;
            case ' ':
                event.preventDefault();
                if (this.isSlideshow) {
                    this.toggleSlideshowPlayPause();
                } else {
                    this.startSlideshow();
                }
                break;
            case 'f':
            case 'F':
                event.preventDefault();
                this.toggleFavorite();
                break;
            case 'd':
            case 'D':
                event.preventDefault();
                this.downloadImage();
                break;
        }
    }

    showLoading(show) {
        this.loadingOverlay.classList.toggle('hidden', !show);
    }

    showError(message) {
        console.error('Gallery Error:', message);
        // Create a simple error notification
        const errorDiv = document.createElement('div');
        errorDiv.className = 'fixed top-4 right-4 bg-red-500 text-white px-4 py-2 rounded-lg shadow-lg z-50';
        errorDiv.textContent = message;
        document.body.appendChild(errorDiv);

        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (errorDiv.parentNode) {
                errorDiv.parentNode.removeChild(errorDiv);
            }
        }, 5000);
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // FIX 3: Thin wrapper kept for backward-compatibility; delegates to the
    // module-level generateDeterministicId() when a file is available.
    generateId(file) {
        return file ? generateDeterministicId(file) : `img_${Date.now()}`;
    }

    // FIX 2: Revoke all active blob URLs and disconnect observers
    cleanup() {
        this.revokeAllBlobUrls();
        if (this.lazyLoadObserver) this.lazyLoadObserver.disconnect();
        if (this.infiniteScrollObserver) this.infiniteScrollObserver.disconnect();
    }
}

// Initialize the gallery when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.gallery = new PhotoGallery();
});

// Service Worker registration for offline support (optional)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {
            // Service worker registration failed, but app still works
        });
    });
}

// Cleanup on page unload to prevent memory leaks
window.addEventListener('beforeunload', () => {
    if (window.gallery) {
        window.gallery.cleanup();
    }
});