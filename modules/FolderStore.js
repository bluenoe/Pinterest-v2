/**
 * FolderStore.js
 * Remembers the folders you opened (File System Access API, Chrome/Edge),
 * so the welcome screen can offer "Continue" instead of picking them again.
 *
 * Browsers without showDirectoryPicker (Firefox, Safari) keep working with the
 * classic folder picker; they just do not get the remembered list.
 *
 * Private windows: reading a stored folder handle back from IndexedDB crashed
 * Chromium's incognito mode in testing, and a private window forgets
 * everything anyway, so remembering is switched off there.
 */

import { withStore, isIndexedDBAvailable } from './LocalDB.js';

const MAX_REMEMBERED = 12;

export function isFolderMemorySupported() {
    return typeof window !== 'undefined' &&
        typeof window.showDirectoryPicker === 'function' &&
        isIndexedDBAvailable();
}

let availability = null;

/**
 * True when folders can be remembered safely: the API exists and this does
 * not look like a private window. Chromium gives private windows a storage
 * quota bounded by memory; a quota below twice the JS heap limit is the
 * usual sign (the same check detectIncognito uses). A false alarm only means
 * folders are not remembered.
 *
 * @returns {Promise<boolean>}
 */
export function isFolderMemoryAvailable() {
    if (!availability) {
        availability = (async () => {
            if (!isFolderMemorySupported()) return false;
            try {
                const { quota } = await navigator.storage.estimate();
                const heapLimit = performance?.memory?.jsHeapSizeLimit;
                if (quota && heapLimit && quota < heapLimit * 2) return false;
            } catch {
                return false;
            }
            return true;
        })();
    }
    return availability;
}

/** Remembered folders, most recently opened first. */
export async function listFolders() {
    const all = await withStore('folders', 'readonly', (store, p) => p(store.getAll()));
    return (all || []).sort((a, b) => b.lastOpened - a.lastOpened);
}

/**
 * Add or refresh a folder. Folders are matched with isSameEntry(), so opening
 * the same folder again updates its record instead of adding a duplicate.
 *
 * @returns {Promise<number>} the folder's id
 */
export async function rememberFolder(handle, photoCount) {
    const existing = await listFolders();
    let match = null;
    for (const rec of existing) {
        try {
            if (await rec.handle.isSameEntry(handle)) { match = rec; break; }
        } catch {
            // Stale handle: ignore
        }
    }

    const record = {
        ...(match || {}),
        name: handle.name,
        handle,
        photoCount,
        lastOpened: Date.now()
    };
    const id = await withStore('folders', 'readwrite', (store, p) => p(store.put(record)));

    // Keep the list short: forget the oldest ones
    const extra = existing.filter(r => !match || r.id !== match.id).slice(MAX_REMEMBERED - 1);
    if (extra.length > 0) {
        await withStore('folders', 'readwrite', store => { extra.forEach(r => store.delete(r.id)); });
    }
    return id;
}

export async function forgetFolder(id) {
    await withStore('folders', 'readwrite', store => { store.delete(id); });
    const session = await getLastSession();
    if (session.includes(id)) await setLastSession(session.filter(x => x !== id));
}

export async function setLastSession(ids) {
    await withStore('meta', 'readwrite', store => { store.put(ids, 'lastSession'); });
}

export async function getLastSession() {
    const ids = await withStore('meta', 'readonly', (store, p) => p(store.get('lastSession')));
    return Array.isArray(ids) ? ids : [];
}

/**
 * Make sure we may read the folder. Chrome asks the user (once, or "on every
 * visit" if they choose so); this must run inside a click handler.
 *
 * @returns {Promise<boolean>}
 */
export async function ensureReadPermission(handle) {
    try {
        if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
        return (await handle.requestPermission({ mode: 'read' })) === 'granted';
    } catch {
        return false;
    }
}
