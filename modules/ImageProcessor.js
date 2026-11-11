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

// .jfif / .pjpeg / .pjp are plain JPEGs (Windows often saves web images as .jfif)
export const IMAGE_EXTENSIONS = /\.(jpe?g|jfif|pjpeg|pjp|png|apng|gif|bmp|webp|avif|svg)$/i;

// How many images are decoded in parallel while reading dimensions.
const METADATA_CONCURRENCY = 8;

// How many files are opened in parallel while reading a folder.
const READ_CONCURRENCY = 32;

/** True for files the gallery can display (by extension, like the folder picker). */
export function isImageFile(file) {
    return IMAGE_EXTENSIONS.test(file.name);
}

/**
 * Counts the files a folder import skipped, by extension, so "no photos found"
 * can say what was there instead (e.g. "120 .heic").
 */
export class SkippedFiles {
    constructor() {
        this.counts = new Map();
    }

    add(name) {
        const dot = name.lastIndexOf('.');
        if (dot <= 0) return; // no extension, or a hidden file like ".DS_Store"
        const ext = name.slice(dot).toLowerCase();
        this.counts.set(ext, (this.counts.get(ext) || 0) + 1);
    }

    /** @returns {Array<[string, number]>} most common extensions first */
    top(n = 3) {
        return [...this.counts].sort((a, b) => b[1] - a[1]).slice(0, n);
    }
}

/** Run fn over items with at most `limit` calls in flight; keeps the order. */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * Path of a file relative to the folder the user opened, e.g. "travel/beach/a.jpg".
 *
 * The folder picker fills in webkitRelativePath. Files that come from drag-and-drop
 * or from a remembered folder handle do not have it, so the importers below store
 * the same path in `_relativePath`. Using one helper everywhere means a photo gets
 * the same ID (and keeps its favorite) however its folder was opened.
 *
 * @param {File} file
 * @returns {string} '' for loose files that are not inside a folder
 */
export function relativePathOf(file) {
    return file.webkitRelativePath || file._relativePath || '';
}

function setRelativePath(file, path) {
    // Only paths inside a folder count (matches what the folder picker reports)
    if (path.includes('/')) file._relativePath = path;
    return file;
}

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
    const raw = `${file.name}|${file.size}|${file.lastModified}|${relativePathOf(file)}`;
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
 * Album = the folder that directly contains the photo.
 * e.g. "holidays/beach/img.jpg" → "beach"
 *      "img.jpg"                → "Main"
 *
 * @param {File} file
 * @returns {string}
 */
function parseAlbum(file) {
    const parts = (relativePathOf(file) || file.name).split('/');
    return parts.length > 1 ? parts[parts.length - 2] : 'Main';
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
        path:         relativePathOf(file) || file.name,
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

    images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return images;
}

// ---------------------------------------------------------------------------
// Folder ingestion: drag-and-drop and remembered folder handles
// ---------------------------------------------------------------------------

/**
 * Recursively collect image files from a FileSystemEntry (drag-and-drop API).
 * Each file gets the folder-relative path the picker would have reported.
 * readEntries() is paginated, so it is called until it returns an empty batch.
 *
 * @param {FileSystemEntry} entry
 * @param {File[]}          result  - Array to push files into (mutated).
 * @param {SkippedFiles}    [skipped] - Collects files that are not supported images.
 * @returns {Promise<void>}
 */
export function collectFilesFromEntry(entry, result, skipped) {
    return new Promise(resolve => {
        if (entry.isFile) {
            if (!IMAGE_EXTENSIONS.test(entry.name)) {
                skipped?.add(entry.name);
                resolve();
                return;
            }
            entry.file(
                file => {
                    result.push(setRelativePath(file, entry.fullPath.replace(/^\//, '')));
                    resolve();
                },
                () => resolve()
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
                                await collectFilesFromEntry(e, result, skipped);
                            }
                            readBatch();
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
 * Recursively collect image files from a FileSystemDirectoryHandle
 * (File System Access API: folder picker, remembered folders, Chrome/Edge drag-and-drop).
 *
 * A subfolder that cannot be read (system folder, no permission, removed
 * meanwhile) is skipped so the rest of the folder still opens. Only an
 * unreadable top folder throws.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {SkippedFiles} [skipped] - Collects files that are not supported images.
 * @returns {Promise<File[]>}
 */
export async function collectFilesFromDirectoryHandle(dirHandle, skipped) {
    const files = [];
    const walk = async (dir, path) => {
        const fileHandles = [];
        const subfolders = [];
        for await (const handle of dir.values()) {
            const childPath = `${path}/${handle.name}`;
            if (handle.kind === 'directory') {
                subfolders.push([handle, childPath]);
            } else if (IMAGE_EXTENSIONS.test(handle.name)) {
                fileHandles.push([handle, childPath]);
            } else {
                skipped?.add(handle.name);
            }
        }

        const read = await mapLimit(fileHandles, READ_CONCURRENCY, async ([handle, childPath]) => {
            try {
                return setRelativePath(await handle.getFile(), childPath);
            } catch {
                return null; // Unreadable file (deleted meanwhile, permission): skip it
            }
        });
        for (const file of read) if (file) files.push(file);

        for (const [handle, childPath] of subfolders) {
            try {
                await walk(handle, childPath);
            } catch (err) {
                console.warn(`Skipping folder that could not be read: ${childPath}`, err);
            }
        }
    };
    await walk(dirHandle, dirHandle.name);
    return files;
}

/**
 * Turn a drop into folders: every dropped directory becomes its own folder
 * (with its handle when the browser provides one, so it can be remembered),
 * loose image files are grouped as "Dropped files".
 *
 * Everything is read from the DataTransfer synchronously first: the browser
 * empties it as soon as the drop event handler returns.
 *
 * @param {DataTransfer} dataTransfer
 * @param {SkippedFiles} [skipped] - Collects files that are not supported images.
 * @returns {Promise<Array<{name: string, files: File[], handle: FileSystemDirectoryHandle|null}>>}
 */
export async function collectDroppedFolders(dataTransfer, skipped) {
    const items = Array.from(dataTransfer.items || []).filter(item => item.kind === 'file');
    const grabbed = items.map(item => ({
        handle: typeof item.getAsFileSystemHandle === 'function'
            ? item.getAsFileSystemHandle().catch(() => null)
            : null,
        entry: typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
        file: item.getAsFile()
    }));
    const fallbackFiles = items.length === 0 ? Array.from(dataTransfer.files || []) : [];

    const folders = [];
    const loose = [];
    const addLoose = (file) => {
        if (isImageFile(file)) loose.push(file);
        else skipped?.add(file.name);
    };
    fallbackFiles.forEach(addLoose);

    for (const g of grabbed) {
        const handle = g.handle ? await g.handle : null;
        if (handle && handle.kind === 'directory') {
            try {
                folders.push({ name: handle.name, files: await collectFilesFromDirectoryHandle(handle, skipped), handle });
                continue;
            } catch (err) {
                console.warn(`Could not read dropped folder "${handle.name}" via its handle:`, err);
                // fall through to the entry API below
            }
        }
        if (g.entry && g.entry.isDirectory) {
            const files = [];
            await collectFilesFromEntry(g.entry, files, skipped);
            folders.push({ name: g.entry.name, files, handle: null });
        } else if (g.file && !(handle && handle.kind === 'directory')) {
            addLoose(g.file);
        }
    }

    if (loose.length > 0) folders.push({ name: 'Dropped files', files: loose, handle: null });
    return folders.filter(f => f.files.length > 0);
}
