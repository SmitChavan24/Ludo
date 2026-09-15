import webpush from 'web-push';
import { config } from '../config.js';
import { store } from '../db/store.js';

// ──────────────────────────────────────────────────────────────────────────
// Web push notifications.
//
// Push is the only way to pull someone back to a tournament they entered hours
// earlier — without it a scheduled event relies on players remembering.
//
// If VAPID keys aren't configured the whole thing no-ops: nothing throws,
// nothing is stored, the app simply doesn't send notifications.
// ──────────────────────────────────────────────────────────────────────────
export class PushService {
  constructor() {
    this.enabled = config.push.enabled;
    if (this.enabled) {
      webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
    } else {
      console.log('[push] disabled — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to enable');
    }
  }

  publicKey() {
    return this.enabled ? config.push.publicKey : null;
  }

  async subscribe(userId, subscription) {
    if (!this.enabled) return null;
    const { endpoint, keys } = subscription || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) throw new Error('Invalid push subscription');
    return store.savePushSubscription({
      endpoint,
      userId,
      p256dh: keys.p256dh,
      auth: keys.auth,
      createdAt: Date.now(),
    });
  }

  async unsubscribe(endpoint) {
    if (!this.enabled || !endpoint) return false;
    return store.deletePushSubscription(endpoint);
  }

  // Send to every device a user registered. Subscriptions the push service
  // reports as gone (404/410) are deleted — otherwise dead endpoints pile up
  // forever and every later send gets slower.
  async sendToUser(userId, payload) {
    if (!this.enabled) return { sent: 0, removed: 0 };
    const subs = await store.listPushSubscriptions(userId);
    let sent = 0;
    let removed = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 600 },
        );
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await store.deletePushSubscription(s.endpoint);
          removed++;
        }
        // Other failures (rate limits, transient errors) are swallowed on
        // purpose: a notification must never break the game flow behind it.
      }
    }
    return { sent, removed };
  }

  // Does this player have at least one live device registered? This is the
  // server-side half of the "notifications required" gate — a client can lie
  // about permission, but it cannot fake a stored subscription.
  async hasSubscription(userId) {
    if (!this.enabled) return true; // push not configured -> never block anyone
    const subs = await store.listPushSubscriptions(userId);
    return subs.length > 0;
  }

  // Everyone who has ever allowed notifications.
  async sendToAll(payload) {
    if (!this.enabled) return { sent: 0, removed: 0, recipients: 0 };
    const userIds = await store.listAllPushUserIds();
    const result = await this.sendToUsers(userIds, payload);
    return { ...result, recipients: userIds.length };
  }

  async sendToUsers(userIds, payload) {
    const results = await Promise.all([...new Set(userIds)].map((id) => this.sendToUser(id, payload)));
    return results.reduce((a, r) => ({ sent: a.sent + r.sent, removed: a.removed + r.removed }), { sent: 0, removed: 0 });
  }
}

export const push = new PushService();

// Notification copy lives in one place so the wording stays consistent.
export const notify = {
  lobbyOpen: (t, minutes) => ({
    title: `${t.title} — lobby is open`,
    body: `Starts in ${minutes} minutes. Tap to join the lobby.`,
    tag: `t-${t.id}-lobby`,
    url: `/tournaments/${t.id}`,
  }),
  starting: (t) => ({
    title: `${t.title} is starting`,
    body: 'Your first match is being drawn — tap to play.',
    tag: `t-${t.id}-start`,
    url: `/tournaments/${t.id}`,
  }),
  matchReady: (t, opponentName) => ({
    title: 'Your match is ready',
    body: opponentName ? `You're up against ${opponentName}.` : 'Tap to play your match.',
    tag: `t-${t.id}-match`,
    url: `/tournaments/${t.id}`,
  }),
  claimApproved: (t) => ({
    title: 'Payment confirmed ✅',
    body: `You're in: ${t.title}.`,
    tag: `t-${t.id}-claim`,
    url: `/tournaments/${t.id}`,
  }),
  claimRejected: (t, reason) => ({
    title: 'Payment could not be confirmed',
    body: reason || `We couldn't verify your payment for ${t.title}.`,
    tag: `t-${t.id}-claim`,
    url: `/tournaments/${t.id}`,
  }),
  cancelled: (t) => ({
    title: `${t.title} was cancelled`,
    body: 'Not enough players joined. Any entry fee will be returned.',
    tag: `t-${t.id}-cancel`,
    url: `/tournaments/${t.id}`,
  }),
  won: (t, amountInr) => ({
    title: '🏆 You won the tournament!',
    body: amountInr ? `${t.title} — ₹${amountInr} prize.` : t.title,
    tag: `t-${t.id}-won`,
    url: `/tournaments/${t.id}`,
  }),
};
