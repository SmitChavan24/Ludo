/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

// Workbox fills this in at build time (injectManifest strategy).
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ── Web push ──
// The server sends JSON: { title, body, tag, url }.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'CoinLudo', body: event.data?.text?.() || '' };
  }

  const title = data.title || 'CoinLudo';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // A tag replaces an earlier notification with the same tag instead of
      // stacking, so a player never wakes to ten copies of the same alert.
      tag: data.tag || 'coinludo',
      renotify: true,
      data: { url: data.url || '/' },
    }),
  );
});

// Tapping a notification focuses an existing tab if there is one, rather than
// opening a duplicate — important when the target is a live match.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate?.(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
