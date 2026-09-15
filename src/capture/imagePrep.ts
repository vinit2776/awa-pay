// Extracted from CaptureForm.tsx (phase 14) so the offline draft-flush
// path can downscale/hash a queued file identically to the online path,
// rather than growing a second copy that quietly drifts.

const MAX_DIMENSION = 2000;
const JPEG_QUALITY = 0.82;

export async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Downscales to at most MAX_DIMENSION on the longer edge (never upscales)
// and re-encodes as JPEG. This also drops EXIF and picks up the browser's
// EXIF auto-orientation on draw, so output comes out right-side-up.
export async function downscaleImage(file: File | Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable.");
  ctx.drawImage(bitmap, 0, 0, width, height);

  return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
}
