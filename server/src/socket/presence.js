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
    for (const room of this.manager.rooms.values()) {
      if (room.status === 'waiting') waiting += room.seats.length;
      else if (room.status === 'playing') playing += room.seats.length;
    }
    return { online: this.sockets.size, waiting, playing };
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
