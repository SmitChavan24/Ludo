import { io } from 'socket.io-client';
import { SERVER_URL } from '../config.js';
import { useGame } from '../store/game.js';
import { useAuth } from '../store/auth.js';

let socket = null;

export function getSocket() {
  return socket;
}

// Connect (authenticated by JWT) and route every server event into the stores.
export function connectSocket(token) {
  if (socket) socket.disconnect();
  // Empty SERVER_URL (production build) → connect to the current origin.
  socket = io(SERVER_URL || undefined, { auth: { token }, transports: ['websocket'] });

  const g = () => useGame.getState();

  socket.on('connect', () => g().setConnected(true));
  socket.on('disconnect', () => g().setConnected(false));
  socket.on('connect_error', (err) => {
    g().setConnected(false);
    g().setError(err.message);
  });
  socket.on('error', (err) => g().setError(err?.message || err?.code || 'Error'));

  socket.on('room:update', (room) => g().setRoom(room));
  socket.on('room:error', (e) => g().setError(e.message));
  socket.on('room:left', () => g().reset());

  socket.on('game:start', (p) => g().onGameStart(p));
  socket.on('game:sync', (snap) => g().applySync(snap));
  socket.on('game:rolled', (p) => g().onRolled(p));
  socket.on('game:moved', (p) => g().onMoved(p));
  socket.on('game:state', (p) => g().onState(p));
  socket.on('game:over', (p) => g().onOver(p));
  socket.on('game:aborted', (p) => g().onAborted(p));

  socket.on('wallet:balance', ({ coins }) => useAuth.getState().setCoins(coins));
  socket.on('presence', (p) => g().setPresence(p));

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// Promise-based emit using socket.io acks, so callers can await + catch errors.
// Every request carries a timeout. Without one, emitting while the socket is
// down just buffers the packet and the promise hangs forever — the UI would sit
// on a spinner with no explanation.
function emitAck(event, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('Not connected to the server'));
    if (!socket.connected) return reject(new Error('Reconnecting to the server — try again in a moment'));

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The server did not respond. Please try again.'));
    }, timeoutMs);

    socket.emit(event, payload, (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (res && res.ok === false) reject(new Error(res.error?.message || 'Request failed'));
      else resolve(res);
    });
  });
}

// A fresh random seed the player contributes to each game's provably-fair dice.
// Because the server publishes its seed hash before the game starts, this seed
// stops the operator from pre-selecting favourable rolls.
function randomSeed() {
  const a = new Uint8Array(16);
  (globalThis.crypto || window.crypto).getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const gameApi = {
  quick: (stake, maxPlayers) => emitAck('lobby:quick', { stake, maxPlayers, clientSeed: randomSeed() }),
  practice: () => emitAck('lobby:practice', { clientSeed: randomSeed() }),
  create: (stake, maxPlayers) => emitAck('lobby:create', { stake, maxPlayers, clientSeed: randomSeed() }),
  join: (roomId) => emitAck('lobby:join', { roomId, clientSeed: randomSeed() }),
  leave: () => emitAck('lobby:leave', {}),
  roll: () => emitAck('game:roll', {}),
  move: (tokenIndex) => emitAck('game:move', { tokenIndex }),
  sync: () => emitAck('game:sync', {}),
};
