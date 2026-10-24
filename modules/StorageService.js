/**
 * StorageService.js
 * Single-responsibility module for all localStorage reads and writes.
 *
 * Responsibilities:
 *  - Load / persist the favorites Set (image IDs).
 *  - Load / persist the UI theme preference ('dark' | 'light').
 *  - Expose helpers so callers never touch localStorage directly.
 */

const FAVORITES_KEY = 'gallery-favorites';
const THEME_KEY     = 'gallery-theme';

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

/**
 * Load favorites from localStorage and return them as a Set<string>.
 * Returns an empty Set when nothing is stored or JSON is malformed.
 * @returns {Set<string>}
 */
export function loadFavorites() {
    try {
        const raw = localStorage.getItem(FAVORITES_KEY);
        return new Set(raw ? JSON.parse(raw) : []);
    } catch {
        return new Set();
    }
}

/**
 * Persist a favorites Set to localStorage.
 * @param {Set<string>} favorites
 */
export function saveFavorites(favorites) {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
}

/**
 * Toggle an image ID in the favorites Set, persist the change, and
 * return the updated Set.
 *
 * @param {Set<string>} favorites  - Current favorites Set (mutated in-place).
 * @param {string}      imageId    - ID of the image to toggle.
 * @returns {Set<string>}          - The same (now updated) Set.
 */
export function toggleFavorite(favorites, imageId) {
    if (!imageId) {
        console.warn('StorageService.toggleFavorite: imageId is falsy, skipping.');
        return favorites;
    }
    if (favorites.has(imageId)) {
        favorites.delete(imageId);
    } else {
        favorites.add(imageId);
    }
    saveFavorites(favorites);
    return favorites;
}

// ---------------------------------------------------------------------------
// Theme preference
// ---------------------------------------------------------------------------

/**
 * Read the saved theme from localStorage.
 * @returns {'dark'|'light'|null}
 */
export function loadTheme() {
    return localStorage.getItem(THEME_KEY); // 'dark', 'light', or null
}

/**
 * Persist the current theme string.
 * @param {'dark'|'light'} theme
 */
export function saveTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
}

/**
 * Apply the correct dark/light class to <html> based on saved preference
 * or system preference, and return the effective theme string.
 * @returns {'dark'|'light'}
 */
export function applyInitialTheme() {
    const saved      = loadTheme();
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark     = saved === 'dark' || (!saved && prefersDark);

    document.documentElement.classList.toggle('dark', isDark);
    return isDark ? 'dark' : 'light';
}
