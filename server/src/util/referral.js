import crypto from 'node:crypto';

// Short, human-friendly referral codes. The alphabet deliberately omits
// characters people confuse when retyping a code from a chat message
// (0/O, 1/I/L), because these get shared over WhatsApp by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newReferralCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Normalize whatever the user pasted (spare spaces, lower case, a full URL).
export function normalizeReferralCode(input) {
  if (!input) return '';
  const raw = String(input).trim();
  // Accept a pasted invite link too, e.g. https://site/?ref=ABC123
  const fromUrl = raw.match(/[?&]ref=([A-Za-z0-9]+)/);
  return (fromUrl ? fromUrl[1] : raw).toUpperCase().slice(0, 12);
}
