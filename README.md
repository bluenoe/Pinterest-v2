# Gallery

A quiet, Pinterest-style viewer for the photos on your computer. Open a folder and browse it as one endless masonry grid. Everything runs in the browser; no photo is ever uploaded.

## Features

- Masonry grid that stays put while more photos load
- Smooth scrolling with large folders: thumbnails are made in a background worker and kept between visits
- Remembers folders you drag onto the page (Chrome, Edge): reopen the last session with one click
- Albums from subfolders, search by file or album name
- Sort by name, newest, oldest or largest
- Favorites, saved in the browser
- Full-screen viewer with slideshow and download
- Frosted-glass look with a floating top bar, soft shadows and an indigo accent
- Light and dark theme, follows the system by default
- Respects the system's reduced-motion setting
- Works offline once loaded

## Usage

1. Open the site.
2. Choose a folder, or drag one onto the page. Add more folders if you like.
3. Open the photos.

"Choose a folder" uses the browser's standard folder picker, which works with any folder, including Downloads, Desktop and Documents. Chrome asks you to confirm before it hands the files to the page; nothing is uploaded.

Folders you **drag** onto the page are remembered in Chrome and Edge: next time the page shows **Continue** with the folders from your last visit. The browser asks once for permission to read them; choose "Allow on every visit" to skip the question afterwards.

## Keyboard

| Key | Action |
| --- | --- |
| `/` | Search |
| Arrow keys | Move between photos in the grid |
| `Enter` | Open the focused photo |
| `←` `→` | Previous / next photo |
| `Space` | Start or pause the slideshow |
| `F` | Favorite |
| `D` | Download |
| `Esc` | Close, or clear the search |

## Browser support

| | Grid, viewer, favorites | Remembered folders |
| --- | --- | --- |
| Chrome, Edge | yes | yes, for dragged folders |
| Firefox, Safari | yes | no (pick the folder each time) |

The page must be served over `http(s)`. Opening `index.html` directly from disk (`file://`) blocks the JavaScript modules and the thumbnail worker.

## Design

All styling lives in `styles.css`. Colours, shadows and radii are CSS variables at the top of the file: `:root` holds the light theme, `.dark` the dark one.

- **Accent**: indigo (`--accent`, `--accent-text`, `--accent-soft`) marks primary buttons, focus rings and switched-on toggles. Red (`--heart`) is used for favorites only.
- **Surfaces**: the top bar, the start-page panel and the viewer controls are frosted glass (`--glass`) floating over the photos.
- **Icons**: thin-line SVG symbols in the sprite at the top of `index.html`; scripts insert them with `icons.js`. `#i-logo` is the brand mark, and the favicon uses the same shape.
- **Motion**: photo cards lift on hover and on keyboard focus. With reduced motion turned on, nothing lifts, zooms or floats.
- **Layout**: the start page uses two columns from 960px wide. Below 768px the search moves to its own row in the top bar. The grid shows 2 to 6 columns depending on the window width.

## Development

```bash
npm install
npm run build:css   # Tailwind: src/input.css → dist/styles.css
npm run watch:css   # rebuild on change
npm run check       # syntax check of all modules
```

Serve the folder with any static server, for example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

After editing `styles.css`, run `npm run build:css` and commit `dist/styles.css` as well; the site loads the built file.

The service worker checks with the server on every request, so a normal reload shows your changes.

## Project structure

```
index.html                  markup, icon sprite and logo
styles.css                  design tokens and all styles (built into dist/styles.css)
script.js                   app: wires the modules together
modules/
  VirtualGrid.js            masonry layout, windowing, keyboard navigation
  ThumbnailService.js       thumbnail queue, memory and disk cache
  ThumbnailWorker.js        decodes and resizes photos off the main thread
  LightboxController.js     viewer and slideshow
  ImageProcessor.js         reads folders, dimensions, stable photo IDs
  GalleryRenderer.js        filters, sorting, header and folder list
  FolderStore.js            remembered folders
  LocalDB.js                IndexedDB storage
  StorageService.js         favorites, theme and sort preferences
  icons.js                  SVG icon helper
sw.js                       offline cache (network first)
```

## Privacy

Photos are read directly from your disk and never leave the device. Favorites, preferences, remembered folders and thumbnails are stored in this browser only; clearing the site data removes them.
