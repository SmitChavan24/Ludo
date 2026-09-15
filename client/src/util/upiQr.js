import jsQR from 'jsqr';

// ──────────────────────────────────────────────────────────────────────────
// Reading a UPI ID out of a QR code.
//
// Typing a UPI ID by hand is the highest-risk step in a payout: one wrong
// character and real money goes to a stranger, irreversibly. Scanning the
// player's own UPI QR removes that risk entirely.
//
// Uses the browser's native BarcodeDetector where it exists (Android Chrome —
// fast and no download), and falls back to jsQR everywhere else.
// ──────────────────────────────────────────────────────────────────────────

function hasNativeDetector() {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

async function nativeDetect(source) {
  try {
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    const codes = await detector.detect(source);
    return codes?.[0]?.rawValue || null;
  } catch {
    return null;
  }
}

// Draw whatever we were given onto a canvas and hand the pixels to jsQR.
function decodeWithJsQr(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const result = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  return result?.data || null;
}

// Decode a QR from an uploaded/photographed image file.
export async function decodeQrFromFile(file) {
  const bitmap = await createImageBitmap(file);
  try {
    if (hasNativeDetector()) {
      const native = await nativeDetect(bitmap);
      if (native) return native;
    }
    // Large photos decode poorly and slowly; cap the long edge.
    const max = 1200;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    return decodeWithJsQr(bitmap, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  } finally {
    bitmap.close?.();
  }
}

// Decode from a live <video> frame.
export async function decodeQrFromVideo(video) {
  if (!video.videoWidth) return null;
  if (hasNativeDetector()) {
    const native = await nativeDetect(video);
    if (native) return native;
  }
  return decodeWithJsQr(video, video.videoWidth, video.videoHeight);
}

// Pull the payee address (the UPI ID) out of whatever the QR contained.
// Handles a full `upi://pay?pa=...` payload as well as a bare id.
export function extractUpiId(raw) {
  if (!raw) return null;
  const text = String(raw).trim();

  const match = text.match(/[?&]pa=([^&\s]+)/i);
  if (match) {
    try {
      return decodeURIComponent(match[1]).trim();
    } catch {
      return match[1].trim();
    }
  }
  // Some QRs hold just the VPA.
  if (/^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9.\-_]{1,32}$/.test(text)) return text;
  return null;
}

// Also useful for showing who the QR belongs to, as a sanity check.
export function extractPayeeName(raw) {
  const match = String(raw || '').match(/[?&]pn=([^&\s]+)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
  } catch {
    return null;
  }
}
