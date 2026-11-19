// ──────────────────────────────────────────────────────────────────────────
// Presence — how many real people are here right now.
//
// A lobby that says "Finding players…" with no other signal reads as abandoned,
// and new users leave. Showing a live count ("12 online, 3 looking for a game")
// tells them whether it's worth waiting — and tells YOU whether your player pool
// is actually too thin.
//
// Counts are per-USER (not per-socket), so two tabs count once.
// ──────────────────────────────────────────────────────────────────────────
export class Presence {
  constructor(io, manager) {
    this.io = io;
    this.manager = manager;
    this.sockets = new Map(); // userId -> socket count
  }

  add(userId) {
    this.sockets.set(userId, (this.sockets.get(userId) || 0) + 1);
    this.broadcast();
  }

  remove(userId) {
    const n = (this.sockets.get(userId) || 0) - 1;
    if (n > 0) this.sockets.set(userId, n);
    else this.sockets.delete(userId);
    this.broadcast();
  }

  snapshot() {
    let waiting = 0;
    let playing = 0;
    // Quick Match only pairs players at the same stake and table size, so the
    // lobby shows who is waiting (and playing) for each "players:stake" pair.
    // Only public coin tables count: private friend rooms and practice games
    // aren't joinable from Quick Match.
    const waitingBy = {};
    const playingBy = {};
    for (const room of this.manager.rooms.values()) {
      const key = `${room.maxPlayers}:${room.stake}`;
      const queue = !room.isPrivate && !room.isPractice;
      if (room.status === 'waiting') {
        waiting += room.seats.length;
        if (queue) waitingBy[key] = (waitingBy[key] || 0) + room.seats.length;
      } else if (room.status === 'playing') {
        playing += room.seats.length;
        if (queue) playingBy[key] = (playingBy[key] || 0) + room.seats.length;
      }
    }
    return { online: this.sockets.size, waiting, playing, waitingBy, playingBy };
  }

  broadcast() {
    // Coalesce bursts (mass reconnects) into one emit per tick.
    if (this._pending) return;
    this._pending = true;
    setImmediate(() => {
      this._pending = false;
      this.io.emit('presence', this.snapshot());
    });
  }

  // Games starting/ending change the waiting/playing split without any
  // connect/disconnect, so refresh on a slow tick as well.
  startTicker(ms = 5000) {
    this._ticker = setInterval(() => {
      if (this.sockets.size > 0) this.io.emit('presence', this.snapshot());
    }, ms);
    this._ticker.unref?.();
    return this;
  }

  stopTicker() {
    if (this._ticker) clearInterval(this._ticker);
  }
}
