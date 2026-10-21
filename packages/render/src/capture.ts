/**
 * Sizing for screenshots, shared by every renderer. It has no imports, so the
 * desktop app's render host can bundle it too.
 */

/** Device pixels per CSS pixel a render can ask for (screenshots go to 3, exports to 4). */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

/**
 * The longest side, in device pixels, of one capture. With GPU compositing,
 * Chrome draws a capture into one texture, and past 16384 (the texture size
 * of current GPUs) the image comes back with tiles repeated. Software
 * compositing has no such limit, but WebGL can't tell the two apart: it
 * reports 8192 under SwiftShader, which captures far more than that.
 */
export const MAX_CAPTURE_PX = 16384;

export function clampScale(scale: number | undefined): number {
  const s = scale ?? 1;
  return Number.isFinite(s) ? Math.min(Math.max(s, MIN_SCALE), MAX_SCALE) : 1;
}

/**
 * The scale to capture a `width`×`height` CSS px area at: the one asked for,
 * or less when the image would be longer than `limit` device pixels.
 */
export function captureScale(
  width: number,
  height: number,
  scale: number | undefined,
  limit = MAX_CAPTURE_PX,
): number {
  const s = clampScale(scale);
  const long = Math.max(width, height);
  if (!(long > 0) || Math.ceil(long * s) <= limit) return s;
  // Rounded down, so rounding the image size can't push it past the limit.
  return Math.floor((limit / long) * 1000) / 1000;
}

/**
 * Waits for every image, lazy ones included: a capture reaches below the
 * viewport, where lazy images otherwise never load.
 */
export const IMAGES_READY_SCRIPT = `Promise.all([...document.images].map((i) => { if (i.loading === 'lazy') i.loading = 'eager'; return i.decode().catch(() => {}); }))`;
