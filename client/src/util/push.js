import { apiFetch } from '../api/http.js';
import { useAuth } from '../store/auth.js';

// Web push, client side.
//
// Browsers only grant notification permission in response to a real user
// gesture, so this must be called from a click — never on page load. Asking
// unprompted is also the fastest way to get permanently denied.

const token = () => useAuth.getState().accessToken;

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function pushPermission() {
  return pushSupported() ? Notification.permission : 'unsupported';
}

// VAPID keys travel as base64url but the API wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// `navigator.serviceWorker.ready` NEVER resolves when no service worker is
// registered — awaiting it bare will hang the UI forever. Always race it.
async function readyRegistration(timeoutMs = 8000) {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

// Ask permission, subscribe, and register the subscription with the server.
// Returns 'subscribed' | 'denied' | 'unsupported' | 'unavailable' | 'no-sw'.
export async function enablePush() {
  if (!pushSupported()) return 'unsupported';

  const { publicKey } = await apiFetch('/push/key').catch(() => ({ publicKey: null }));
  if (!publicKey) return 'unavailable'; // server has no VAPID keys configured

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  const reg = await readyRegistration();
  if (!reg) return 'no-sw'; // service worker never activated
  // Reuse an existing subscription if the browser already has one.
  const subscription =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true, // required by Chrome
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await apiFetch('/push/subscribe', {
    method: 'POST',
    token: token(),
    body: { subscription: subscription.toJSON() },
  });
  return 'subscribed';
}

export async function disablePush() {
  if (!pushSupported()) return false;
  const reg = await readyRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return false;
  await apiFetch('/push/unsubscribe', { method: 'POST', token: token(), body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
  return true;
}

export async function isPushEnabled() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const reg = await readyRegistration(4000);
  if (!reg) return false;
  return !!(await reg.pushManager.getSubscription());
}
