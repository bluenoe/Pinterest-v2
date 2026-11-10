/**
 * LocalDB.js
 * Tiny IndexedDB wrapper shared by the folder list and the thumbnail cache.
 * Everything stays in this browser; nothing is uploaded.
 *
 * Stores:
 *  - folders: remembered folder handles  { id, name, handle, photoCount, lastOpened }
 *  - meta:    small key/value records    (e.g. 'lastSession' → [folderId, ...])
 *  - thumbs:  generated thumbnails       { key, fp, blob, color, width, height, t }
 */

const DB_NAME = 'gallery';
const DB_VERSION = 1;

let dbPromise = null;

export function isIndexedDBAvailable() {
    return typeof indexedDB !== 'undefined';
}

export function openDB() {
    if (!isIndexedDBAvailable()) return Promise.reject(new Error('IndexedDB unavailable'));
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('folders')) {
                db.createObjectStore('folders', { keyPath: 'id', autoIncrement: true });
            }
            if (!db.objectStoreNames.contains('meta')) {
                db.createObjectStore('meta');
            }
            if (!db.objectStoreNames.contains('thumbs')) {
                const thumbs = db.createObjectStore('thumbs', { keyPath: 'key' });
                thumbs.createIndex('t', 't');
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            // Another tab upgraded the schema: drop this connection
            db.onversionchange = () => { db.close(); dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
        req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB blocked')); };
    });
    return dbPromise;
}

function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Run fn(store) inside a transaction and resolve with fn's result once the
 * transaction has committed.
 */
export async function withStore(storeName, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        Promise.resolve(fn(store, promisify)).then(r => { result = r; }, reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
}

export { promisify };
