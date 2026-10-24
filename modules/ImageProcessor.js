/**
 * ImageProcessor.js
 * Single-responsibility module for all file-ingestion and blob-URL lifecycle concerns.
 *
 * Responsibilities:
 *  - Deterministic ID generation (djb2 hash over stable file fingerprint).
 *  - File-list ingestion from directory picker and drag-and-drop DataTransfer.
 *  - Recursive FileSystem API directory walker (collectFilesFromEntry).
 *  - Image metadata extraction (dimensions, album path parsing).
 *  - Controlled, on-demand blob URL lifecycle (create, cache, revoke).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i;

// ---------------------------------------------------------------------------
// P0 FIX 3: Deterministic ID generator (djb2 hash)
// ---------------------------------------------------------------------------

/**
 * Produce a stable, session-persistent ID for a File based on immutable
 * fingerprint fields.  The same physical file re-selected after a page reload
 * will always produce the same ID, making localStorage favorites reliable.
 *
 * @param {File} file
 * @returns {string}  e.g. "img_1a2b3c4d"
 */
export function generateDeterministicId(file) {
    const raw = `${file.name}|${file.size}|${file.lastModified}|${file.webkitRelativePath || ''}`;
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
        hash = ((hash << 5) + hash) ^ raw.charCodeAt(i);
        hash = hash & hash; // coerce to 32-bit signed integer
    }
    return 'img_' + (hash >>> 0).toString(16); // unsigned hex string
}

// ---------------------------------------------------------------------------
// P0 FIX 2: Blob URL lifecycle management
// ---------------------------------------------------------------------------

/**
 * Return an existing cached blob URL for imageId, or create and cache a new
 * one by looking up the File reference in the images array.
 *
 * @param {string}               imageId      - Deterministic image ID.
 * @param {Map<string,string>}   blobUrlCache - The shared active-URL cache.
 * @param {Array<{id,file}>}     images       - Master image record array.
 * @returns {string|null}
 */
export function getOrCreateBlobUrl(imageId, blobUrlCache, images) {
    if (blobUrlCache.has(imageId)) {
        return blobUrlCache.get(imageId);
    }
    const image = images.find(img => img.id === imageId);
    if (!image || !image.file) return null;
    const url = URL.createObjectURL(image.file);
    blobUrlCache.set(imageId, url);
    return url;
}

/**
 * Revoke a single cached blob URL and remove it from the cache.
 *
 * @param {string}              imageId
 * @param {Map<string,string>}  blobUrlCache
 */
export function revokeBlobUrl(imageId, blobUrlCache) {
    const url = blobUrlCache.get(imageId);
    if (url) {
        URL.revokeObjectURL(url);
        blobUrlCache.delete(imageId);
    }
}

/**
 * Revoke every cached blob URL and empty the cache.
 * Call this on gallery reset or page unload.
 *
 * @param {Map<string,string>} blobUrlCache
 */
export function revokeAllBlobUrls(blobUrlCache) {
    blobUrlCache.forEach(url => URL.revokeObjectURL(url));
    blobUrlCache.clear();
}

// ---------------------------------------------------------------------------
// File ingestion helpers
// ---------------------------------------------------------------------------

/**
 * Extract the album name from a file's webkitRelativePath.
 * e.g. "holidays/beach/img.jpg" → "beach"
 *      "img.jpg"                → "Main"
 *
 * @param {File} file
 * @returns {string}
 */
function parseAlbum(file) {
    const pathParts = file.webkitRelativePath
        ? file.webkitRelativePath.split('/')
        : [file.name];
    return pathParts.length > 1 ? pathParts[pathParts.length - 2] : 'Main';
}

/**
 * Load an image to extract its natural dimensions.
 * Uses a short-lived blob URL that is revoked immediately after the load
 * event fires — never stored in the persistent blob-URL cache.
 *
 * @param {File} file
 * @returns {Promise<{id, name, file, path, album, width, height, size, lastModified, type}>}
 */
export function loadImageMetadata(file) {
    return new Promise((resolve, reject) => {
        const tempUrl = URL.createObjectURL(file);
        const img     = new Image();

        img.onload = () => {
            URL.revokeObjectURL(tempUrl); // Release immediately — not cached
            resolve({
                id:           generateDeterministicId(file),
                name:         file.name,
                file:         file,         // Raw File ref; blob URL created on demand
                path:         file.webkitRelativePath || file.name,
                album:        parseAlbum(file),
                width:        img.naturalWidth  || img.width,
                height:       img.naturalHeight || img.height,
                size:         file.size,
                lastModified: file.lastModified,
                type:         file.type,
            });
        };

        img.onerror = () => {
            URL.revokeObjectURL(tempUrl);
            reject(new Error(`Failed to decode image: ${file.name}`));
        };

        img.src = tempUrl;
    });
}

/**
 * Process a flat array of File objects: filter by extension, extract
 * metadata for each, and return a sorted image-record array.
 *
 * @param {File[]}              files
 * @param {Map<string,string>}  blobUrlCache - Existing cache to clear first.
 * @returns {Promise<Array>}
 */
export async function processImages(files, blobUrlCache) {
    const imageFiles = files.filter(f => IMAGE_EXTENSIONS.test(f.name));

    // P0 FIX 2: Revoke any URLs from a previous gallery load before rebuilding
    revokeAllBlobUrls(blobUrlCache);

    const images = [];
    for (const file of imageFiles) {
        try {
            images.push(await loadImageMetadata(file));
        } catch (err) {
            console.warn('ImageProcessor: skipping file:', file.name, err.message);
        }
    }

    images.sort((a, b) => a.name.localeCompare(b.name));
    return images;
}

// ---------------------------------------------------------------------------
// P0 FIX 4: Drag-and-drop ingestion with directory traversal
// ---------------------------------------------------------------------------

/**
 * Recursively collect all File objects from a FileSystemEntry.
 * Handles both FileSystemFileEntry and FileSystemDirectoryEntry.
 * readEntries() may return batches smaller than the full directory listing,
 * so we loop until an empty batch is returned.
 *
 * @param {FileSystemEntry} entry
 * @param {File[]}          result  - Array to push files into (mutated).
 * @returns {Promise<void>}
 */
export function collectFilesFromEntry(entry, result) {
    return new Promise(resolve => {
        if (entry.isFile) {
            entry.file(
                file => { result.push(file); resolve(); },
                ()   => resolve()
            );
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const readBatch = () => {
                reader.readEntries(
                    async entries => {
                        if (entries.length === 0) {
                            resolve();
                        } else {
                            for (const e of entries) {
                                await collectFilesFromEntry(e, result);
                            }
                            readBatch(); // readEntries may be paginated
                        }
                    },
                    () => resolve()
                );
            };
            readBatch();
        } else {
            resolve();
        }
    });
}

/**
 * Normalise a DataTransfer object (from a drag-and-drop event) into an array
 * of image File objects, following directory entries recursively when possible.
 *
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<File[]>}  Only image files; empty if none found.
 */
export async function collectDroppedImageFiles(dataTransfer) {
    const allFiles = [];

    if (dataTransfer.items && dataTransfer.items.length > 0) {
        const entries = [];
        for (const item of dataTransfer.items) {
            if (item.kind !== 'file') continue;
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
            if (entry) {
                entries.push(entry);
            } else {
                const file = item.getAsFile();
                if (file) allFiles.push(file);
            }
        }
        for (const entry of entries) {
            await collectFilesFromEntry(entry, allFiles);
        }
    } else {
        // Fallback: plain FileList (older browsers)
        for (const file of dataTransfer.files) allFiles.push(file);
    }

    return allFiles.filter(
        f => f.type.startsWith('image/') || IMAGE_EXTENSIONS.test(f.name)
    );
}
