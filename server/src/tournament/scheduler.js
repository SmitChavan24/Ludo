import { tournaments } from './TournamentService.js';
import { store } from '../db/store.js';

// ──────────────────────────────────────────────────────────────────────────
// Auto-start scheduler.
//
// You set a start time; this does the rest. On each tick it looks for OPEN
// tournaments whose start time has passed and:
//   • ≥2 players paid  → draws the bracket and begins
//   • <2 players paid  → cancels it (coin entries are refunded automatically;
//                        manual/UPI entries are listed for you to refund, since
//                        only you can send money back out)
//
// Deliberately a poll rather than one timer per tournament: it survives a
// restart, and a missed tick just means starting a few seconds late.
// ──────────────────────────────────────────────────────────────────────────
export class TournamentScheduler {
  constructor({ intervalMs = 15000, onEvent = null } = {}) {
    this.intervalMs = intervalMs;
    this.onEvent = onEvent;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[tournaments] tick failed:', e.message)), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()) {
    if (this.running) return []; // never overlap ticks
    this.running = true;
    const actions = [];
    try {
      // 1. Registration → lobby, once the lobby time arrives.
      const open = await store.listTournaments({ status: 'open', limit: 100 });
      for (const t of open) {
        if (!t.autoStart || !t.startsAt) continue;
        const lobbyAt = t.lobbyOpensAt ?? t.startsAt;
        if (lobbyAt <= now && t.startsAt > now) {
          await tournaments.openLobby(t.id);
          actions.push({ type: 'lobby', id: t.id, title: t.title });
        }
      }

      // 2. Lobby (or still-open) → start, once the start time arrives.
      const ready = [
        ...(await store.listTournaments({ status: 'lobby', limit: 100 })),
        ...(await store.listTournaments({ status: 'open', limit: 100 })),
      ];
      for (const t of ready) {
        if (!t.autoStart || !t.startsAt || t.startsAt > now) continue;

        const entries = await store.listTournamentEntries(t.id);
        if (entries.length >= 2) {
          await tournaments.start(t.id);
          actions.push({ type: 'started', id: t.id, title: t.title, players: entries.length });
        } else {
          // Not enough players turned up — don't hold anyone's money.
          await tournaments.cancel(t.id, { refund: true });
          actions.push({
            type: 'cancelled',
            id: t.id,
            title: t.title,
            reason: 'not enough players',
            // Manual (real-money) entries can only be refunded by you.
            refundManually: t.entryType === 'manual' ? entries.map((e) => ({ userId: e.userId, name: e.name, paymentRef: e.paymentRef })) : [],
          });
        }
      }
    } finally {
      this.running = false;
    }
    for (const a of actions) {
      console.log(`[tournaments] ${a.type}: ${a.title} (${a.id})`);
      this.onEvent?.(a);
    }
    return actions;
  }
}

export const scheduler = new TournamentScheduler();
