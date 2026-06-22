import crypto from 'node:crypto';

// Constant-time string comparison that also doesn't leak length: both sides are
// reduced to fixed-size SHA-256 digests before the timing-safe compare. Used for
// admin credentials and the admin API key.
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}
