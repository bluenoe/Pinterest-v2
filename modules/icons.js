/**
 * icons.js
 * Thin-line SVG icons. The <symbol> sprite lives at the top of index.html;
 * this helper returns markup that references it.
 *
 * Available: search, heart, play, pause, stop, skip-back, skip-forward,
 * chevrons-down, moon, sun, x, chevron-left, chevron-right, download,
 * upload, folder, check, lock, image
 */
export function icon(name, extraClass = '') {
    const cls = extraClass ? `icon ${extraClass}` : 'icon';
    return `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}
