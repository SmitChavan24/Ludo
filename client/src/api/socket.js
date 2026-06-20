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
  socket = io(SERVER_URL, { auth: { token }, transports: ['websocket'] });

  const g = () => useGame.getState();

  socket.on('connect_error', (err) => g().setError(err.message));
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

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// Promise-based emit using socket.io acks, so callers can await + catch errors.
function emitAck(event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error('Not connected'));
    socket.emit(event, payload, (res) => {
      if (res && res.ok === false) reject(new Error(res.error?.message || 'Request failed'));
      else resolve(res);
    });
  });
}

export const gameApi = {
  quick: (stake, maxPlayers) => emitAck('lobby:quick', { stake, maxPlayers }),
  create: (stake, maxPlayers) => emitAck('lobby:create', { stake, maxPlayers }),
  join: (roomId) => emitAck('lobby:join', { roomId }),
  leave: () => emitAck('lobby:leave', {}),
  roll: () => emitAck('game:roll', {}),
  move: (tokenIndex) => emitAck('game:move', { tokenIndex }),
  sync: () => emitAck('game:sync', {}),
};
