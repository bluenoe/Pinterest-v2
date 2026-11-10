/**
 * ThumbnailWorker.js
 * Runs off the main thread so scrolling never stalls on image decoding.
 *
 * Input:  { id, file, width, keepAlpha }
 * Output: { id, blob, width, height, color: [r, g, b] }  or  { id, error }
 *
 * - Decodes and downsizes the photo with createImageBitmap (resize happens
 *   during decode, so the full-resolution bitmap is never kept around).
 * - Samples a 1×1 average colour used as the card's placeholder tint.
 * - Encodes JPEG for opaque photos; WebP (PNG fallback) when the source may
 *   have transparency, so transparent PNGs never get a black background.
 */

self.onmessage = async (event) => {
    const { id, file, width, keepAlpha } = event.data;
    try {
        const bitmap = await createImageBitmap(file, {
            resizeWidth: width,
            resizeQuality: 'medium',
            imageOrientation: 'from-image'
        });

        // Average colour (browser box-filters the whole image down to 1px)
        const tiny = new OffscreenCanvas(1, 1);
        const tinyCtx = tiny.getContext('2d', { willReadFrequently: true });
        tinyCtx.drawImage(bitmap, 0, 0, 1, 1);
        const [r, g, b, a] = tinyCtx.getImageData(0, 0, 1, 1).data;

        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const result = { width: bitmap.width, height: bitmap.height };
        bitmap.close();

        const blob = await canvas.convertToBlob(
            keepAlpha
                ? { type: 'image/webp', quality: 0.85 }
                : { type: 'image/jpeg', quality: 0.82 }
        );

        // Mostly transparent images: no meaningful tint
        const color = a < 128 ? null : [r, g, b];
        self.postMessage({ id, blob, color, ...result });
    } catch (error) {
        self.postMessage({ id, error: String(error && error.message || error) });
    }
};
