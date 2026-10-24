/**
 * GalleryRenderer.js
 * Single-responsibility module for all DOM rendering and filtering logic.
 *
 * Responsibilities:
 *  - XSS-safe gallery card construction (createGalleryItem).
 *  - Masonry layout via CSS columns (no JS measurement needed).
 *  - Aspect-ratio placeholder boxes to prevent layout reflow during lazy load.
 *  - Lazy-load IntersectionObserver wired to on-demand blob URL allocation.
 *  - Infinite scroll IntersectionObserver.
 *  - Filter engine: by album, by search query, by favorites.
 *  - Album selector DOM updates.
 *  - Photo count and favorites-badge header updates.
 *  - Folder list rendering in the welcome screen.
 */

// ---------------------------------------------------------------------------
// P0 FIX 1: XSS-safe HTML escaping
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe insertion into HTML attribute values or inner text
 * when using template literals inside innerHTML.
 *
 * @param {string|null|undefined} str
 * @returns {string}
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Format a byte count into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k     = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i     = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ---------------------------------------------------------------------------
// Lazy-load IntersectionObserver
// ---------------------------------------------------------------------------

/**
 * Build and return a lazy-load IntersectionObserver.
 * When an <img data-file-id="…"> enters the viewport, the observer calls
 * getBlobUrl() to obtain (or create) the blob URL on demand, then loads the
 * image and reveals it.
 *
 * @param {function(string): string|null} getBlobUrl
 *        Callback that takes an imageId and returns a blob URL (or null).
 * @returns {IntersectionObserver}
 */
export function createLazyLoadObserver(getBlobUrl) {
    return new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;

            const img     = entry.target;
            const imageId = img.dataset.fileId;
            if (!imageId) return;

            const blobUrl = getBlobUrl(imageId);
            if (!blobUrl) return;

            const tempImg   = new Image();
            tempImg.onload  = () => {
                img.src = blobUrl;
                img.removeAttribute('data-file-id');
                img.classList.remove('loading-skeleton');
                img.classList.add('lazy-loaded');
            };
            tempImg.src = blobUrl;

            // Stop observing regardless of success/failure
            entry.target._lazyObserver?.unobserve(img);
        });
    }, { rootMargin: '200px' });
}

// ---------------------------------------------------------------------------
// Infinite-scroll IntersectionObserver
// ---------------------------------------------------------------------------

/**
 * Attach or re-attach an infinite-scroll sentinel to trigger loadMore()
 * when the user scrolls near the bottom of the grid.
 *
 * @param {HTMLElement}  loadMoreContainer
 * @param {function()}   loadMore
 * @param {function(): boolean} hasMore   Returns true when more pages exist.
 * @returns {IntersectionObserver}
 */
export function setupInfiniteScroll(loadMoreContainer, loadMore, hasMore) {
    let sentinel = document.getElementById('infiniteScrollSentinel');
    if (!sentinel) {
        sentinel             = document.createElement('div');
        sentinel.id          = 'infiniteScrollSentinel';
        sentinel.style.height = '1px';
        loadMoreContainer.parentNode.insertBefore(sentinel, loadMoreContainer);
    }
    loadMoreContainer.classList.add('hidden');

    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting && hasMore()) loadMore();
        });
    }, { rootMargin: '200px' });

    observer.observe(sentinel);
    return observer;
}

// ---------------------------------------------------------------------------
// Gallery card construction
// ---------------------------------------------------------------------------

/**
 * Build a single gallery-card DOM element for an image record.
 * All user-controlled text (filename, metadata) is set via textContent.
 * The <img> receives data-file-id so the lazy-load observer can allocate
 * a blob URL on demand rather than at construction time.
 *
 * @param {object}      image         - Image record from ImageProcessor.
 * @param {Set<string>} favorites     - Current favorites set.
 * @param {function(number): void}     onOpen       - Called with the image's
 *                                                    index in filteredImages.
 * @param {function(number): void}     onSlideshow  - Called with index.
 * @param {function(string): void}     onFavorite   - Called with imageId.
 * @param {IntersectionObserver}       lazyObserver - Observer to register img.
 * @param {function(string): number}   findIndex    - Returns filteredImages
 *                                                    index for an imageId.
 * @returns {HTMLElement}
 */
export function createGalleryItem(
    image, favorites, onOpen, onSlideshow, onFavorite, lazyObserver, findIndex
) {
    const isFavorited = favorites.has(image.id);
    const aspectRatio = (image.height / image.width * 100).toFixed(2);

    const item         = document.createElement('div');
    item.className     = 'gallery-item';
    item.dataset.imageId = image.id;

    // Static structural HTML only — image.id is a hex hash (no user input)
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

    // P0 FIX 1: user-controlled text always via textContent
    item.querySelector('.gallery-item-title').textContent = image.name;
    item.querySelector('.gallery-item-meta').textContent  =
        `${formatFileSize(image.size)} • ${image.width}×${image.height}`;
    item.querySelector('img').alt = image.name;

    // Click → open lightbox
    item.addEventListener('click', e => {
        if (!e.target.closest('.gallery-action-btn')) {
            const idx = findIndex(image.id);
            if (idx !== -1) onOpen(idx);
        }
    });

    // Slideshow button
    item.querySelector('.slideshow-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        const idx = findIndex(image.id);
        if (idx !== -1) onSlideshow(idx);
    });

    // Favorite button
    item.querySelector('.favorite-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        onFavorite(image.id);
    });

    // P0 FIX 2: register with lazy observer; blob URL allocated on viewport entry
    const img = item.querySelector('img');
    if (img) {
        img._lazyObserver = lazyObserver;
        lazyObserver.observe(img);
    }

    return item;
}

// ---------------------------------------------------------------------------
// Filter engine
// ---------------------------------------------------------------------------

/**
 * Apply album, favorites, and text-search filters to the master image array.
 *
 * @param {Array}       images
 * @param {string}      currentAlbum     - 'all' or an album name.
 * @param {boolean}     showFavoritesOnly
 * @param {Set<string>} favorites
 * @param {string}      searchQuery      - Already lowercased.
 * @returns {Array}     Filtered image array.
 */
export function applyFilters(images, currentAlbum, showFavoritesOnly, favorites, searchQuery) {
    let filtered = images;

    if (currentAlbum !== 'all') {
        filtered = filtered.filter(img => img.album === currentAlbum);
    }
    if (showFavoritesOnly) {
        filtered = filtered.filter(img => favorites.has(img.id));
    }
    if (searchQuery) {
        filtered = filtered.filter(img =>
            img.name.toLowerCase().includes(searchQuery) ||
            img.album.toLowerCase().includes(searchQuery)
        );
    }
    return filtered;
}

// ---------------------------------------------------------------------------
// Album selector DOM update
// ---------------------------------------------------------------------------

/**
 * Repopulate the album <select> element and show/hide it based on album count.
 *
 * @param {Map<string, Array>} albums
 * @param {HTMLSelectElement}  albumSelect
 * @param {HTMLElement}        albumSelector  - Wrapper div to show/hide.
 */
export function renderAlbumSelector(albums, albumSelect, albumSelector) {
    albumSelect.innerHTML = '<option value="all">All Photos</option>';
    for (const [name, imgs] of albums) {
        if (name === 'all') continue;
        const opt         = document.createElement('option');
        opt.value         = name;
        opt.textContent   = `${name} (${imgs.length})`;
        albumSelect.appendChild(opt);
    }
    albumSelector.classList.toggle('hidden', albums.size <= 2);
}

// ---------------------------------------------------------------------------
// Photo count & favorites badge
// ---------------------------------------------------------------------------

/**
 * Update the header photo-count text span.
 *
 * @param {HTMLElement} photoCountEl
 * @param {number}      total
 * @param {number}      favoritesCount
 */
export function renderPhotoCount(photoCountEl, total, favoritesCount) {
    let text = `${total} photo${total !== 1 ? 's' : ''}`;
    if (favoritesCount > 0) {
        text += ` • ${favoritesCount} favorite${favoritesCount !== 1 ? 's' : ''}`;
    }
    photoCountEl.textContent = text;
}

/**
 * Update (or remove) the favorites-count badge on the heart toggle button.
 *
 * @param {HTMLElement} favoritesToggleBtn
 * @param {number}      count
 */
export function renderFavoritesBadge(favoritesToggleBtn, count) {
    if (!favoritesToggleBtn) return;
    let badge = favoritesToggleBtn.querySelector('.favorites-badge');
    if (count > 0) {
        if (!badge) {
            badge           = document.createElement('span');
            badge.className = 'favorites-badge';
            favoritesToggleBtn.appendChild(badge);
        }
        badge.textContent = count;
    } else {
        badge?.remove();
    }
}

// ---------------------------------------------------------------------------
// Folder list (welcome screen)
// ---------------------------------------------------------------------------

/**
 * Render the selected-folders list on the welcome screen using safe DOM
 * construction so that folder names are always set via textContent.
 *
 * @param {Array}       selectedFolders
 * @param {HTMLElement} containerEl        - #selectedFoldersList
 * @param {HTMLElement} startGalleryBtn    - To update label / disabled state.
 * @param {function(number): void}         onToggle   - Toggle selection.
 * @param {function(): void}               onSelectAll
 * @param {function(): void}               onDeselectAll
 * @param {function(number): void}         onRemove
 */
export function renderSelectedFolders(
    selectedFolders, containerEl, startGalleryBtn,
    onToggle, onSelectAll, onDeselectAll, onRemove
) {
    const selectedCount      = selectedFolders.filter(f => f.selected !== false).length;
    const totalSelectedFiles = selectedFolders
        .filter(f => f.selected !== false)
        .reduce((sum, f) => sum + f.files.length, 0);

    // Update Start button
    if (selectedFolders.length > 0 && selectedCount > 0) {
        startGalleryBtn.disabled    = false;
        startGalleryBtn.textContent =
            `Explore ${totalSelectedFiles} files from ${selectedCount} folder${selectedCount > 1 ? 's' : ''}`;
    } else {
        startGalleryBtn.disabled    = true;
        startGalleryBtn.textContent = selectedFolders.length > 0
            ? 'Select at least one folder'
            : 'Start Exploring';
    }

    // Static controls (no user data in this HTML)
    let controlsHTML = '';
    if (selectedFolders.length > 1) {
        controlsHTML = `
            <div class="folder-selection-controls">
                <button id="_selectAllBtn" class="folder-selection-btn">
                    <i class="fas fa-check-double mr-1"></i>Select All
                </button>
                <button id="_deselectAllBtn" class="folder-selection-btn">
                    <i class="fas fa-times mr-1"></i>Deselect All
                </button>
            </div>
        `;
    }

    containerEl.innerHTML = controlsHTML;

    // Wire up Select All / Deselect All via addEventListener (not onclick=)
    containerEl.querySelector('#_selectAllBtn')?.addEventListener('click', onSelectAll);
    containerEl.querySelector('#_deselectAllBtn')?.addEventListener('click', onDeselectAll);

    // P0 FIX 1: Build folder items with textContent for all user-provided text
    selectedFolders.forEach((folder, index) => {
        const isSelected = folder.selected !== false;

        const folderItem         = document.createElement('div');
        folderItem.className     = `folder-item ${isSelected ? 'selected' : ''}`;
        folderItem.addEventListener('click', () => onToggle(index));

        // Static HTML scaffold — no user data here
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

        // User-controlled text via textContent
        folderItem.querySelector('.folder-name').textContent  = folder.name;
        folderItem.querySelector('.folder-count').textContent = `(${folder.files.length} files)`;
        folderItem.querySelector('.folder-remove-btn').addEventListener('click', e => {
            e.stopPropagation();
            onRemove(index);
        });

        containerEl.appendChild(folderItem);
    });
}
