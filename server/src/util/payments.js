// Validation for player-submitted payment references (UPI UTR / bank RRN).
//
// This is a first-line sanity filter, NOT proof of payment — the only thing that
// proves payment is you seeing the credit in your account. Its job is to stop
// obvious junk and to normalise the value so duplicate detection actually works
// ("  utr-1234 " and "UTR1234" must not slip through as two different refs).

// A UPI UTR is 12 digits; other bank references vary, so accept a sensible
// alphanumeric range rather than over-fitting to one format.
const UTR_RE = /^[A-Z0-9]{6,24}$/;

export function normalizeUtr(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[\s-]/g, '') // people paste "1234 5678 9012" or "utr-1234"
    .slice(0, 24);
}

export function isValidUtr(input) {
  return UTR_RE.test(normalizeUtr(input));
}

// UPI deep link / QR payload, so the UI can render a "pay ₹X" button that opens
// the user's UPI app pre-filled. `tr` is our own reference for reconciliation.
export function upiPayLink({ upiId, upiName, amountInr, note, ref }) {
  if (!upiId) return null;
  const params = new URLSearchParams({
    pa: upiId,
    pn: upiName || 'CoinLudo',
    cu: 'INR',
  });
  if (amountInr > 0) params.set('am', String(amountInr));
  if (note) params.set('tn', String(note).slice(0, 50));
  if (ref) params.set('tr', String(ref).slice(0, 35));
  return `upi://pay?${params.toString()}`;
}
