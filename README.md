# Pinterest-Style Photo Gallery

A modern, responsive photo gallery website inspired by Pinterest's design, featuring a masonry layout, favorites system, slideshow functionality, and much more.

## Features

### Core Functionality
- **🎨 Pinterest-Style Masonry Layout**: Responsive grid that adapts to different screen sizes
- **📁 Folder Selection**: Select entire photo folders using the browser's directory picker
- **🔍 Advanced Search**: Search photos by filename or album name
- **📂 Album Organization**: Automatically groups photos by subfolder structure
- **💖 Favorites System**: Star/like photos and view them in a dedicated section
- **🎥 Slideshow Mode**: Auto-advancing slideshow with customizable intervals
- **🌙 Dark Mode**: Toggle between light and dark themes with system preference detection
- **⚡ Lazy Loading**: Optimized performance for large photo collections

### Image Viewer
- **🖼️ Full-Screen Lightbox**: Immersive viewing experience
- **⌨️ Keyboard Navigation**: Arrow keys, spacebar, ESC support
- **📱 Touch Support**: Swipe gestures on mobile devices
- **💾 Download**: Save images directly from the viewer
- **ℹ️ Image Information**: View file details, dimensions, and metadata

### User Experience
- **📱 Responsive Design**: Works seamlessly on desktop, tablet, and mobile
- **🎭 Smooth Animations**: Elegant transitions and loading effects
- **🎯 Intuitive Controls**: Easy-to-use interface with clear visual feedback
- **💾 Persistent Preferences**: Saves favorites and theme preferences locally

## How to Use

1. **Open the Website**: Launch `index.html` in your web browser
2. **Select Photos**: Click "Select your photo folder" and choose a folder containing images
3. **Start Exploring**: Click "Start Exploring" to load your photo gallery
4. **Navigate**: 
   - Click any photo to open the full-screen viewer
   - Use arrow keys or on-screen buttons to navigate
   - Press spacebar to start/pause slideshow
   - Press 'F' to favorite/unfavorite images
   - Press 'D' to download the current image

## Keyboard Shortcuts (in Lightbox Mode)

| Key | Action |
|-----|--------|
| `←` / `→` | Navigate between images |
| `Space` | Start/pause slideshow |
| `Esc` | Close lightbox |
| `F` | Toggle favorite |
| `D` | Download image |

## Browser Compatibility

- **Chrome/Edge**: Full support with directory picker
- **Firefox**: Full support with directory picker
- **Safari**: Full support with directory picker
- **Mobile Browsers**: Full support with file selection

## Technical Implementation

### Technologies Used
- **HTML5**: Semantic markup and modern web standards
- **CSS3**: Grid layout, animations, and responsive design
- **Tailwind CSS**: Utility-first CSS framework for rapid styling
- **Vanilla JavaScript**: No external dependencies for maximum performance
- **Font Awesome**: Beautiful icons throughout the interface

### Key Features Implementation
- **File API**: For reading local image files
- **Intersection Observer**: For efficient lazy loading
- **LocalStorage**: For persisting user preferences and favorites
- **CSS Grid & Flexbox**: For responsive masonry layout
- **CSS Custom Properties**: For dynamic theming

## File Structure

```
Pinterest-v2/
├── index.html          # Main HTML file
├── styles.css          # Custom CSS styles
├── script.js           # Main JavaScript application
└── README.md           # This documentation
```

## Additional Features Suggestions

### Enhanced User Experience
1. **🎵 Background Music**: Add ambient music during slideshow mode
2. **🎨 Image Filters**: Apply Instagram-style filters to photos
3. **📊 Photo Statistics**: Show shooting date, camera info, location data
4. **🏷️ Tagging System**: Add custom tags to organize photos
5. **📤 Sharing**: Share individual photos or albums via social media
6. **🔗 Deep Linking**: Direct URLs to specific photos or albums

### Advanced Organization
1. **📅 Timeline View**: Organize photos by date taken
2. **🗺️ Map Integration**: Show photo locations on a map
3. **👥 Face Recognition**: Group photos by people (using browser ML APIs)
4. **🎯 Smart Albums**: Auto-create albums based on content analysis
5. **🔄 Sync**: Cloud storage integration (Google Drive, Dropbox)

### Performance & Accessibility
1. **♿ Accessibility**: Full ARIA support and keyboard navigation
2. **🌐 PWA**: Progressive Web App with offline support
3. **📱 Native Apps**: Electron wrapper for desktop applications
4. **🔧 Customization**: User-configurable grid sizes and layouts
5. **🎨 Themes**: Multiple color schemes and UI themes

### Professional Features
1. **📸 EXIF Data**: Display detailed camera settings and metadata
2. **🖨️ Print Layouts**: Photo printing and album creation
3. **🎬 Video Support**: Include video files in the gallery
4. **📱 Multi-Format**: Support for RAW, HEIC, and other formats
5. **⚡ Bulk Operations**: Select multiple photos for batch actions

## Privacy & Security

- **🔒 Local Processing**: All images are processed locally in your browser
- **🚫 No Upload**: Photos never leave your device
- **💾 Local Storage**: Preferences stored only on your device
- **🔐 No Tracking**: No analytics or user tracking

## Performance Optimization

- **⚡ Lazy Loading**: Images load only when needed
- **🗜️ Image Optimization**: Automatic thumbnail generation
- **📦 Efficient Rendering**: Virtual scrolling for large collections
- **🔄 Caching**: Browser caching for faster subsequent loads
- **📱 Mobile Optimized**: Reduced data usage on mobile devices

## Browser Support Requirements

- **Modern Browsers**: Chrome 80+, Firefox 75+, Safari 13+, Edge 80+
- **File API Support**: Required for folder selection
- **ES6+ Support**: Modern JavaScript features used throughout
- **CSS Grid Support**: For masonry layout implementation

## Development Notes

The application is built with modern web standards and best practices:

- **Modular Design**: Clean separation of concerns
- **Responsive First**: Mobile-first development approach
- **Accessibility**: WCAG 2.1 AA compliance
- **Performance**: Optimized for large photo collections
- **Maintainability**: Well-documented and structured code

---

**Created with ❤️ for photography enthusiasts**

Enjoy exploring your photo collections in this beautiful, Pinterest-inspired gallery!