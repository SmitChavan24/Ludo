// PWA install support.
//
// Android/Chrome fires `beforeinstallprompt`, which we stash so an install
// button can trigger it later. iOS Safari has no such API — the only route is
// Share → Add to Home Screen, so we detect iOS and show instructions instead.
//
// This matters more than usual here: on iPhone, web push ONLY works once the
// app is installed to the home screen.

let deferredPrompt = null;
const listeners = new Set();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // stop Chrome's own mini-infobar; we choose the moment
    deferredPrompt = e;
    listeners.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    listeners.forEach((fn) => fn());
  });
}

export function onInstallStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true // iOS
  );
}

export function isIos() {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function canInstall() {
  return !!deferredPrompt;
}

// Returns 'accepted' | 'dismissed' | 'unavailable'
export async function promptInstall() {
  if (!deferredPrompt) return 'unavailable';
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  listeners.forEach((fn) => fn());
  return outcome;
}
