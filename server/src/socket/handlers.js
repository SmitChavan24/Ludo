import { verifyAccessToken, guestFromPayload } from '../auth/jwt.js';
import { store } from '../db/store.js';
import { GameError } from '../game/LudoEngine.js';
import { config } from '../config.js';
import { Presence } from './presence.js';
import { push } from '../push/PushService.js';

// Every value arriving from a client is untrusted. These coerce-and-check
// helpers keep malformed input from ever reaching the game or the wallet.
const asInt = (v, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
};
const asShortString = (v, max = 128) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length && t.length <= max ? t : null;
};

// Cheap per-socket sliding-window flood guard. Legit play is a handful of events
// per turn, so a generous cap blocks abuse without ever tripping real players.
function rateLimited(socket) {
  const now = Date.now();
  const rl = socket.data.rl;
  if (now > rl.resetAt) {
    rl.count = 0;
    rl.resetAt = now + config.socketRate.windowMs;
  }
  return ++rl.count > config.socketRate.max;
}

// Wire up the real-time layer. Every socket is authenticated at the handshake,
// and every handler is validated and wrapped so a malformed/hostile message can
// only ever produce an error reply — never a crash or an illegal state change.
export function registerSocketHandlers(io, manager) {
  const presence = new Presence(io, manager).startTicker();
  // ── Handshake auth: no valid JWT, no socket. ──
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Auth token required'));
      const payload = verifyAccessToken(token);
      const guest = guestFromPayload(payload);
      if (guest) {
        socket.data.user = guest; // practice-only actor, no DB record
        return next();
      }
      const user = await store.getUser(payload.sub);
      if (!user) return next(new Error('Unknown user'));
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.data.rl = { count: 0, resetAt: Date.now() + config.socketRate.windowMs };
    socket.join(`user:${user.id}`);
    manager.markConnected(user.id, true).catch(() => {});
    presence.add(user.id);
    socket.emit('presence', presence.snapshot());

    // If the user was mid-game (e.g. refreshed the page), resync them.
    const snap = manager.stateForUser(user.id);
    if (snap) {
      socket.join(`room:${snap.room.id}`);
      socket.emit('game:sync', snap);
    }

    // Turn a handler into a safe, ack-able, rate-limited listener.
    const on = (event, fn) =>
      socket.on(event, async (payload, ack) => {
        if (rateLimited(socket)) {
          const clean = { code: 'RATE_LIMIT', message: 'Too many actions — slow down.' };
          socket.emit('error', clean);
          if (typeof ack === 'function') ack({ ok: false, error: clean });
          return;
        }
        try {
          const result = await fn(payload || {});
          if (typeof ack === 'function') ack({ ok: true, ...(result || {}) });
        } catch (err) {
          const clean =
            err instanceof GameError
              ? { code: err.code, message: err.message }
              : { code: 'ERROR', message: 'Request could not be processed' };
          socket.emit('error', clean);
          if (typeof ack === 'function') ack({ ok: false, error: clean });
        }
      });

    const joinSocketRoom = (room) => socket.join(`room:${room.id}`);

    // Private friend room — joined by code, never matched into randomly.
    on('lobby:create', async ({ stake, maxPlayers, rules, clientSeed }) => {
      const s = asInt(stake, { min: 1, max: 10_000_000 });
      const p = asInt(maxPlayers ?? 2, { min: 2, max: 4 });
      if (s === null || p === null) throw new GameError('Invalid game settings', 'BAD_INPUT');
      const room = await manager.createRoom(user, { stake: s, maxPlayers: p, rules, isPrivate: true, clientSeed });
      joinSocketRoom(room);
      socket.emit('room:update', manager.serializeRoom(room));
      return { roomId: room.id };
    });

    on('lobby:join', async ({ roomId, clientSeed }) => {
      if (!asShortString(roomId, 32)) throw new GameError('Invalid room code', 'BAD_INPUT');
      // joinSocketRoom runs the instant the seat is taken, before any
      // game:start broadcast, so this client never misses the kickoff.
      const room = await manager.joinRoom(user, roomId, joinSocketRoom, clientSeed);
      return { roomId: room.id };
    });

    // Random matchmaking at a chosen stake + player count.
    on('lobby:quick', async ({ stake, maxPlayers, clientSeed }) => {
      // The allow-list in GameManager is the real gate; this just rejects junk.
      const s = asInt(stake, { min: 1, max: 10_000_000 });
      const p = asInt(maxPlayers ?? 2, { min: 2, max: 4 });
      if (s === null || p === null) throw new GameError('Invalid game settings', 'BAD_INPUT');
      const room = await manager.quickMatch(user, s, p, joinSocketRoom, clientSeed);
      socket.emit('room:update', manager.serializeRoom(room));
      return { roomId: room.id };
    });

    // Free practice game — no account and no coins required. Looks for a real
    // opponent first; a bot fills in if nobody shows up in time.
    on('lobby:practice', async ({ clientSeed }) => {
      if (!config.practice.enabled) throw new GameError('Practice mode is disabled', 'PRACTICE_OFF');
      if (config.push.requireForPractice && !(await push.hasSubscription(user.id))) {
        throw new GameError('Turn on notifications to play', 'PUSH_REQUIRED');
      }
      const room = await manager.quickMatch(user, 0, 2, joinSocketRoom, asShortString(clientSeed, 64) || '', true);
      socket.emit('room:update', manager.serializeRoom(room));
      return { roomId: room.id, botWaitMs: config.practice.botWaitMs };
    });

    on('lobby:leave', async () => {
      await manager.handleLeave(user.id);
      socket.emit('room:left', {});
      return {};
    });

    on('game:roll', () => ({ result: manager.handleRoll(user.id) }));

    on('game:move', async ({ tokenIndex }) => {
      // A Ludo player has exactly four tokens — anything else is malformed.
      const idx = asInt(tokenIndex, { min: 0, max: 3 });
      if (idx === null) throw new GameError('Invalid token', 'BAD_INPUT');
      return { result: await manager.handleMove(user.id, idx) };
    });

    on('game:sync', () => {
      const s = manager.stateForUser(user.id);
      if (s) socket.join(`room:${s.room.id}`);
      return { snapshot: s };
    });

    socket.on('disconnect', () => {
      // Runs after this socket has left its rooms, so the live-socket check in
      // markConnected sees an accurate count for remaining tabs.
      manager.markConnected(user.id, false).catch(() => {});
      presence.remove(user.id);
    });
  });
}
