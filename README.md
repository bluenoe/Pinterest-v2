# Gallery

A quiet, Pinterest-style viewer for the photos on your computer. Open a folder and browse it as one endless masonry grid. Everything runs in the browser; no photo is ever uploaded.

## Features

- Masonry grid that stays put while more photos load
- Smooth scrolling with large folders: thumbnails are made in a background worker and kept between visits
- Remembers your folders (Chrome, Edge): reopen the last session with one click
- Albums from subfolders, search by file or album name
- Sort by name, newest, oldest or largest
- Favorites, saved in the browser
- Full-screen viewer with slideshow and download
- Light and dark theme, follows the system by default
- Works offline once loaded

## Usage

1. Open the site.
2. Choose a folder, or drag one onto the page. Add more folders if you like.
3. Open the photos.

Next time, Chrome and Edge show **Continue** with the folders from your last visit. The browser asks once for permission to read them; choose "Allow on every visit" to skip the question afterwards.

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
| Chrome, Edge | yes | yes |
| Firefox, Safari | yes | no (pick the folder each time) |

The page must be served over `http(s)`. Opening `index.html` directly from disk (`file://`) blocks the JavaScript modules and the thumbnail worker.

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

## Project structure

```
index.html                  markup and icon sprite
styles.css                  theme (built into dist/styles.css)
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
sw.js                       offline cache
```

## Privacy

Photos are read directly from your disk and never leave the device. Favorites, preferences, remembered folders and thumbnails are stored in this browser only; clearing the site data removes them.
