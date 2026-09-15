// Sharing helpers. In India WhatsApp is the distribution channel, so every share
// path falls back to a WhatsApp deep link when the native share sheet isn't
// available (desktop browsers).

// The public URL of the deployed app. Prefer an explicit build-time value; fall
// back to wherever the app is actually being served from.
export function appUrl() {
  const configured = import.meta.env.VITE_PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${window.location.origin}`;
}

export function inviteUrl(referralCode) {
  const base = appUrl();
  return referralCode ? `${base}/?ref=${encodeURIComponent(referralCode)}` : base;
}

// Try the OS share sheet (mobile), else open WhatsApp, else copy to clipboard.
// Returns 'shared' | 'whatsapp' | 'copied' | 'failed' so callers can show feedback.
export async function shareText(text, url) {
  const full = url ? `${text}\n${url}` : text;

  if (navigator.share) {
    try {
      await navigator.share({ text, url });
      return 'shared';
    } catch (err) {
      // User dismissed the sheet — don't fall through to opening WhatsApp.
      if (err?.name === 'AbortError') return 'failed';
    }
  }

  const wa = `https://wa.me/?text=${encodeURIComponent(full)}`;
  const win = window.open(wa, '_blank', 'noopener');
  if (win) return 'whatsapp';

  try {
    await navigator.clipboard.writeText(full);
    return 'copied';
  } catch {
    return 'failed';
  }
}

// "Come play me" invite, carrying the referral code so both sides earn coins.
export function shareInvite(referralCode, bonus) {
  const reward = bonus ? ` We both get ${bonus} free coins 🪙` : '';
  return shareText(`Play Ludo with me on CoinLudo! 🎲${reward}`, inviteUrl(referralCode));
}

// "I just won" brag — the most natural moment to share.
export function shareWin({ payout, opponents, referralCode }) {
  const who = opponents?.length ? ` against ${opponents.join(', ')}` : '';
  const amount = payout ? ` and won 🪙${payout}` : '';
  return shareText(`I just won a Ludo match${who}${amount} on CoinLudo! 🏆 Think you can beat me?`, inviteUrl(referralCode));
}
