import { verifyAccessToken } from '../auth/jwt.js';
import { store } from '../db/store.js';
import { GameError } from '../game/LudoEngine.js';

// Wire up the real-time layer. Every socket is authenticated at the handshake,
// and every handler is validated and wrapped so a malformed/hostile message can
// only ever produce an error reply — never a crash or an illegal state change.
export function registerSocketHandlers(io, manager) {
  // ── Handshake auth: no valid JWT, no socket. ──
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Auth token required'));
      const payload = verifyAccessToken(token);
      const user = store.getUser(payload.sub);
      if (!user) return next(new Error('Unknown user'));
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);
    manager.markConnected(user.id, true);

    // If the user was mid-game (e.g. refreshed the page), resync them.
    const snap = manager.stateForUser(user.id);
    if (snap) {
      socket.join(`room:${snap.room.id}`);
      socket.emit('game:sync', snap);
    }

    // Turn a handler into a safe, ack-able listener.
    const on = (event, fn) =>
      socket.on(event, async (payload, ack) => {
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
    on('lobby:create', ({ stake, maxPlayers, rules }) => {
      const room = manager.createRoom(user, { stake, maxPlayers, rules, isPrivate: true });
      joinSocketRoom(room);
      socket.emit('room:update', manager.serializeRoom(room));
      return { roomId: room.id };
    });

    on('lobby:join', async ({ roomId }) => {
      // joinSocketRoom runs the instant the seat is taken, before any
      // game:start broadcast, so this client never misses the kickoff.
      const room = await manager.joinRoom(user, roomId, joinSocketRoom);
      return { roomId: room.id };
    });

    // Random matchmaking at a chosen stake + player count.
    on('lobby:quick', async ({ stake, maxPlayers }) => {
      const room = await manager.quickMatch(user, stake, maxPlayers || 2, joinSocketRoom);
      socket.emit('room:update', manager.serializeRoom(room));
      return { roomId: room.id };
    });

    on('lobby:leave', async () => {
      await manager.handleLeave(user.id);
      socket.emit('room:left', {});
      return {};
    });

    on('game:roll', () => ({ result: manager.handleRoll(user.id) }));

    on('game:move', async ({ tokenIndex }) => ({
      result: await manager.handleMove(user.id, tokenIndex),
    }));

    on('game:sync', () => {
      const s = manager.stateForUser(user.id);
      if (s) socket.join(`room:${s.room.id}`);
      return { snapshot: s };
    });

    socket.on('disconnect', () => {
      manager.markConnected(user.id, false);
    });
  });
}
