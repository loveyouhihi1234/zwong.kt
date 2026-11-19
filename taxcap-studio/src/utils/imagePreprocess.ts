import { enhanceCaptchaPixels } from './portalRules.ts';

/**
 * Rasterizes an <img> onto an offscreen canvas with optional Step-2 pixel contrast
 * enhancement & denoising, returning a lightweight WebP/JPEG data URL.
 */
export async function rasterizeImageElement(
  img: HTMLImageElement,
  enhance = true,
): Promise<string | null> {
  if (!img.complete) {
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    });
  }
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;

  const scale = w < 220 ? 1.85 : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d', enhance ? { willReadFrequently: true } : undefined);
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  if (enhance) {
    try {
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      enhanceCaptchaPixels(imgData.data, canvas.width, canvas.height);
      ctx.putImageData(imgData, 0, 0);
    } catch {
      // Fallback safely if canvas is tainted
    }
  }

  const webp = canvas.toDataURL('image/webp', 0.88);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', 0.9);
}
