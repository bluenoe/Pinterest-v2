import { icon } from './icons.js';

/**
 * GalleryRenderer.js
 * Single-responsibility module for all DOM rendering and filtering logic.
 *
 * Responsibilities:
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
// Infinite-scroll IntersectionObserver
// ---------------------------------------------------------------------------

/**
 * Attach or re-attach an infinite-scroll sentinel to trigger loadMore()
 * when the user scrolls near the bottom of the grid.
 *
 * @param {HTMLElement}  loadMoreContainer
 * @param {function()}   loadMore
 * @param {function(): boolean} hasMore   Returns true when more pages exist.
 * @param {number} [prefetchDistance=200] How far below the viewport (px) to start loading.
 * @returns {IntersectionObserver}
 */
export function setupInfiniteScroll(loadMoreContainer, loadMore, hasMore, prefetchDistance = 200) {
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
    }, { rootMargin: `0px 0px ${prefetchDistance}px 0px` });

    observer.observe(sentinel);
    return observer;
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
// Sorting
// ---------------------------------------------------------------------------

export const SORT_MODES = ['name', 'newest', 'oldest', 'largest'];

const byName = (a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) ||
    a.path.localeCompare(b.path);

/**
 * Return a sorted copy of the images.
 *  - name:    natural order ("img2" before "img10")
 *  - newest / oldest: by the file's date (last modified)
 *  - largest: by file size
 *
 * @param {Array}  images
 * @param {string} mode
 * @returns {Array}
 */
export function sortImages(images, mode) {
    const sorted = [...images];
    switch (mode) {
        case 'newest':  sorted.sort((a, b) => (b.lastModified - a.lastModified) || byName(a, b)); break;
        case 'oldest':  sorted.sort((a, b) => (a.lastModified - b.lastModified) || byName(a, b)); break;
        case 'largest': sorted.sort((a, b) => (b.size - a.size) || byName(a, b)); break;
        default:        sorted.sort(byName);
    }
    return sorted;
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
    albumSelect.innerHTML = '<option value="all">All photos</option>';
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
            `Open ${totalSelectedFiles} photos${selectedCount > 1 ? ` from ${selectedCount} folders` : ''}`;
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
                <button type="button" id="_selectAllBtn" class="folder-selection-btn">Select all</button>
                <button type="button" id="_deselectAllBtn" class="folder-selection-btn">None</button>
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
                    ${isSelected ? icon('check') : ''}
                </div>
                ${icon('folder')}
                <span class="folder-name"></span>
                <span class="folder-count"></span>
            </div>
            <div class="folder-actions">
                <button type="button" class="folder-remove-btn" title="Remove folder" aria-label="Remove folder">
                    ${icon('x')}
                </button>
            </div>
        `;

        // User-controlled text via textContent
        folderItem.querySelector('.folder-name').textContent  = folder.name;
        folderItem.querySelector('.folder-count').textContent = `${folder.files.length} photos`;
        folderItem.querySelector('.folder-remove-btn').addEventListener('click', e => {
            e.stopPropagation();
            onRemove(index);
        });

        containerEl.appendChild(folderItem);
    });
}

// ---------------------------------------------------------------------------
// VirtualGrid re-export (Phase P2 DOM Windowing Engine)
// ---------------------------------------------------------------------------
export { VirtualGrid } from './VirtualGrid.js';

