// Pinterest-style Photo Gallery Application
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
        this.slideshowInterval = null;
        this.slideshowSpeed = 3000;
        this.showFavoritesOnly = false;
        this.currentAlbum = 'all';
        this.albums = new Map();
        this.lazyLoadObserver = null;
        
        this.initializeElements();
        this.initializeEventListeners();
        this.initializeDarkMode();
        this.initializeLazyLoading();
    }

    initializeElements() {
        // Welcome screen elements
        this.welcomeScreen = document.getElementById('welcomeScreen');
        this.folderInput = document.getElementById('folderInput');
        this.startGalleryBtn = document.getElementById('startGallery');
        
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
        this.slideshowInterval = document.getElementById('slideshowInterval');
    }

    initializeEventListeners() {
        // Welcome screen events
        this.folderInput.addEventListener('change', (e) => this.handleFolderSelection(e));
        this.startGalleryBtn.addEventListener('click', () => this.startGallery());
        
        // Search and filter events
        this.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        this.albumSelect.addEventListener('change', (e) => this.handleAlbumChange(e.target.value));
        this.favoritesToggle.addEventListener('click', () => this.toggleFavoritesView());
        
        // Lightbox events
        document.getElementById('closeLightbox').addEventListener('click', () => this.closeLightbox());
        document.getElementById('prevImage').addEventListener('click', () => this.navigateImage(-1));
        document.getElementById('nextImage').addEventListener('click', () => this.navigateImage(1));
        this.favoriteBtn.addEventListener('click', () => this.toggleFavorite());
        this.downloadBtn.addEventListener('click', () => this.downloadImage());
        
        // Theme and slideshow events
        this.darkModeToggle.addEventListener('click', () => this.toggleDarkMode());
        this.slideshowBtn.addEventListener('click', () => this.startSlideshow());
        this.loadMoreBtn.addEventListener('click', () => this.loadMoreImages());
        
        // Slideshow control events
        document.getElementById('slideshowPlayPauseBtn').addEventListener('click', () => this.toggleSlideshowPlayPause());
        document.getElementById('slideshowPrevBtn').addEventListener('click', () => this.navigateImage(-1));
        document.getElementById('slideshowNextBtn').addEventListener('click', () => this.navigateImage(1));
        document.getElementById('slideshowStopBtn').addEventListener('click', () => this.stopSlideshow());
        this.slideshowInterval.addEventListener('change', (e) => {
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
        
        document.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.handleDroppedFiles(e.dataTransfer.files);
        });
    }

    initializeDarkMode() {
        const savedTheme = localStorage.getItem('gallery-theme');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        
        if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
            document.documentElement.classList.add('dark');
        }
    }

    initializeLazyLoading() {
        this.lazyLoadObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                        img.classList.remove('loading-skeleton');
                        this.lazyLoadObserver.unobserve(img);
                    }
                }
            });
        }, { rootMargin: '50px' });
    }

    async handleFolderSelection(event) {
        const files = Array.from(event.target.files);
        if (files.length > 0) {
            this.startGalleryBtn.disabled = false;
            this.startGalleryBtn.textContent = `Explore ${files.length} files`;
            this.selectedFiles = files;
        } else {
            this.startGalleryBtn.disabled = true;
            this.startGalleryBtn.textContent = 'Start Exploring';
        }
    }

    async handleDroppedFiles(files) {
        const imageFiles = Array.from(files).filter(file => 
            file.type.startsWith('image/') || 
            /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(file.name)
        );
        
        if (imageFiles.length > 0) {
            this.selectedFiles = imageFiles;
            this.startGalleryBtn.disabled = false;
            this.startGalleryBtn.textContent = `Explore ${imageFiles.length} files`;
        }
    }

    async startGallery() {
        if (!this.selectedFiles || this.selectedFiles.length === 0) return;
        
        this.showLoading(true);
        this.welcomeScreen.style.display = 'none';
        this.galleryContainer.classList.remove('hidden');
        
        try {
            await this.processImages(this.selectedFiles);
            this.organizeAlbums();
            this.renderGallery();
            this.updatePhotoCount();
        } catch (error) {
            console.error('Error starting gallery:', error);
            this.showError('Failed to load images. Please try again.');
        } finally {
            this.showLoading(false);
        }
    }

    async processImages(files) {
        const imageExtensions = /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i;
        const imageFiles = files.filter(file => imageExtensions.test(file.name));
        
        this.images = [];
        
        for (const file of imageFiles) {
            try {
                const url = URL.createObjectURL(file);
                const image = await this.loadImageMetadata(file, url);
                this.images.push(image);
            } catch (error) {
                console.warn('Failed to process image:', file.name, error);
            }
        }
        
        // Sort images by name
        this.images.sort((a, b) => a.name.localeCompare(b.name));
        this.filteredImages = [...this.images];
    }

    async loadImageMetadata(file, url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const pathParts = file.webkitRelativePath ? file.webkitRelativePath.split('/') : [file.name];
                const album = pathParts.length > 1 ? pathParts[pathParts.length - 2] : 'Main';
                
                resolve({
                    id: this.generateId(),
                    name: file.name,
                    file: file,
                    url: url,
                    path: file.webkitRelativePath || file.name,
                    album: album,
                    width: img.width,
                    height: img.height,
                    size: file.size,
                    lastModified: file.lastModified,
                    type: file.type
                });
            };
            img.onerror = reject;
            img.src = url;
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
                this.createGalleryItem(image, startIndex + index);
            }, index * 50); // Staggered loading for animation effect
        });
        
        this.currentPage++;
        
        // Update load more button
        const hasMore = endIndex < this.filteredImages.length;
        this.loadMoreContainer.classList.toggle('hidden', !hasMore);
        
        // Show no results message if no images
        this.noResults.classList.toggle('hidden', this.filteredImages.length > 0);
    }

    createGalleryItem(image, index) {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.dataset.index = index;
        item.dataset.imageId = image.id;
        
        const isFavorited = this.favorites.has(image.id);
        
        item.innerHTML = `
            <img data-src="${image.url}" alt="${image.name}" class="loading-skeleton">
            <div class="gallery-item-overlay">
                <div class="gallery-item-info">
                    <div class="gallery-item-title">${image.name}</div>
                    <div class="gallery-item-meta">${this.formatFileSize(image.size)} • ${image.width}×${image.height}</div>
                </div>
            </div>
            <div class="gallery-item-actions">
                <button class="gallery-action-btn favorite-btn ${isFavorited ? 'favorited' : ''}" data-image-id="${image.id}">
                    <i class="${isFavorited ? 'fas' : 'far'} fa-heart"></i>
                </button>
            </div>
        `;
        
        // Add click event for lightbox
        item.addEventListener('click', (e) => {
            if (!e.target.closest('.gallery-action-btn')) {
                this.openLightbox(index);
            }
        });
        
        // Add favorite button event
        const favoriteBtn = item.querySelector('.favorite-btn');
        favoriteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleImageFavorite(image.id);
        });
        
        this.galleryGrid.appendChild(item);
        
        // Observe for lazy loading
        const img = item.querySelector('img');
        this.lazyLoadObserver.observe(img);
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
        if (this.isSlideshow) {
            this.stopSlideshow();
        }
    }

    updateLightboxImage() {
        if (this.currentIndex < 0 || this.currentIndex >= this.filteredImages.length) return;
        
        const image = this.filteredImages[this.currentIndex];
        this.lightboxImage.src = image.url;
        this.lightboxTitle.textContent = image.name;
        this.lightboxInfo.textContent = `${this.formatFileSize(image.size)} • ${image.width}×${image.height} • ${image.album}`;
        
        // Update favorite button
        const isFavorited = this.favorites.has(image.id);
        this.favoriteBtn.innerHTML = `<i class="${isFavorited ? 'fas' : 'far'} fa-heart"></i>`;
        this.favoriteBtn.classList.toggle('text-red-500', isFavorited);
        
        // Update slideshow active indicator
        document.querySelectorAll('.gallery-item').forEach((item, index) => {
            item.classList.toggle('slideshow-active', this.isSlideshow && index === this.currentIndex);
        });
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
        if (this.currentIndex >= 0 && this.currentIndex < this.filteredImages.length) {
            const image = this.filteredImages[this.currentIndex];
            this.toggleImageFavorite(image.id);
            this.updateLightboxImage();
        }
    }

    toggleImageFavorite(imageId) {
        if (this.favorites.has(imageId)) {
            this.favorites.delete(imageId);
        } else {
            this.favorites.add(imageId);
        }
        
        // Update localStorage
        localStorage.setItem('gallery-favorites', JSON.stringify([...this.favorites]));
        
        // Update UI
        document.querySelectorAll(`[data-image-id="${imageId}"]`).forEach(btn => {
            const isFavorited = this.favorites.has(imageId);
            btn.classList.toggle('favorited', isFavorited);
            btn.innerHTML = `<i class="${isFavorited ? 'fas' : 'far'} fa-heart"></i>`;
        });
        
        // Update favorites toggle badge
        this.updateFavoritesToggle();
        
        // Refresh gallery if showing favorites only
        if (this.showFavoritesOnly) {
            this.applyFilters();
        }
    }

    downloadImage() {
        if (this.currentIndex >= 0 && this.currentIndex < this.filteredImages.length) {
            const image = this.filteredImages[this.currentIndex];
            const link = document.createElement('a');
            link.href = image.url;
            link.download = image.name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }

    startSlideshow() {
        if (this.filteredImages.length === 0) return;
        
        if (!this.isLightboxOpen) {
            this.openLightbox(0);
        }
        
        this.isSlideshow = true;
        this.slideshowControls.classList.remove('hidden');
        this.slideshowBtn.innerHTML = '<i class="fas fa-stop"></i>';
        
        this.restartSlideshowTimer();
        
        // Update play/pause button
        document.getElementById('slideshowPlayPauseBtn').innerHTML = '<i class="fas fa-pause"></i>';
    }

    stopSlideshow() {
        this.isSlideshow = false;
        this.slideshowControls.classList.add('hidden');
        this.slideshowBtn.innerHTML = '<i class="fas fa-play"></i>';
        
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
    }

    toggleDarkMode() {
        const isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('gallery-theme', isDark ? 'dark' : 'light');
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
        alert(message); // In a real app, you'd use a more sophisticated notification system
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    generateId() {
        return Math.random().toString(36).substr(2, 9);
    }
}

// Initialize the gallery when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.gallery = new PhotoGallery();
});

// Service Worker registration for offline support (optional)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
            // Service worker registration failed, but app still works
        });
    });
}