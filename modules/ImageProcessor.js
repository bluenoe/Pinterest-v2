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

export const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|bmp|webp|avif|svg)$/i;

// How many images are decoded in parallel while reading dimensions.
const METADATA_CONCURRENCY = 8;

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
 * @param {Map<string,{id,file}>} imagesById  - Master image records keyed by ID.
 * @returns {string|null}
 */
export function getOrCreateBlobUrl(imageId, blobUrlCache, imagesById) {
    if (blobUrlCache.has(imageId)) {
        return blobUrlCache.get(imageId);
    }
    const image = imagesById.get(imageId);
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
 * Read an image's natural dimensions via a temporary <img> element.
 * The browser only needs the file header to report naturalWidth/Height,
 * so this is much cheaper than a full decode (e.g. createImageBitmap).
 *
 * @param {File} file
 * @returns {Promise<{width: number, height: number}>}
 */
function readDimensions(file) {
    return new Promise((resolve, reject) => {
        const tempUrl = URL.createObjectURL(file);
        const img     = new Image();
        img.onload = () => {
            URL.revokeObjectURL(tempUrl); // Release immediately — not cached
            resolve({
                width:  img.naturalWidth  || img.width,
                height: img.naturalHeight || img.height,
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
 * Build an image record (ID, album, dimensions, file info) for one File.
 *
 * @param {File} file
 * @returns {Promise<{id, name, file, path, album, width, height, size, lastModified, type}>}
 */
export async function loadImageMetadata(file) {
    const { width, height } = await readDimensions(file);
    if (!width || !height) {
        throw new Error(`Image has no dimensions: ${file.name}`);
    }
    return {
        id:           generateDeterministicId(file),
        name:         file.name,
        file:         file,         // Raw File ref; blob URL created on demand
        path:         file.webkitRelativePath || file.name,
        album:        parseAlbum(file),
        width,
        height,
        size:         file.size,
        lastModified: file.lastModified,
        type:         file.type,
    };
}

/**
 * Process a flat array of File objects: filter by extension, extract
 * metadata with a bounded worker pool, and return a sorted image-record array.
 * Files that share an ID (the same file selected twice) are kept once.
 *
 * @param {File[]}              files
 * @param {Map<string,string>}  blobUrlCache - Existing cache to clear first.
 * @param {function(number, number): void} [onProgress] - (done, total)
 * @returns {Promise<Array>}
 */
export async function processImages(files, blobUrlCache, onProgress) {
    const imageFiles = files.filter(f => IMAGE_EXTENSIONS.test(f.name));

    // P0 FIX 2: Revoke any URLs from a previous gallery load before rebuilding
    revokeAllBlobUrls(blobUrlCache);

    const total   = imageFiles.length;
    const results = new Array(total);
    let next = 0;
    let done = 0;
    onProgress?.(0, total);

    const worker = async () => {
        while (next < total) {
            const i = next++;
            try {
                results[i] = await loadImageMetadata(imageFiles[i]);
            } catch (err) {
                console.warn('ImageProcessor: skipping file:', imageFiles[i].name, err.message);
            }
            done++;
            onProgress?.(done, total);
        }
    };

    const poolSize = Math.min(METADATA_CONCURRENCY, total);
    await Promise.all(Array.from({ length: poolSize }, worker));

    const seen   = new Set();
    const images = results.filter(img => {
        if (!img || seen.has(img.id)) return false;
        seen.add(img.id);
        return true;
    });

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
