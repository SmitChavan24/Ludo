import { create } from 'zustand';

// Mirror of the authoritative server game state. The client NEVER computes
// game logic — it only reflects what the server broadcasts and sends intents
// back. Every field here arrives from a socket event.
// Ignore a broadcast that belongs to a different (usually just-left) game.
// Without this, trailing events from an old room can overwrite the live game.
const stale = (s, roomId) => !!(roomId && s.room && s.room.id !== roomId);

export const useGame = create((set) => ({
  status: 'idle', // idle | waiting | playing | finished
  room: null,
  state: null, // engine.getState() snapshot
  commitment: null, // provably-fair commitment (serverSeedHash, clientSeed)
  lastRoll: null,
  lastRoller: null, // who rolled lastRoll (the player on turn when it was rolled)
  lastEvent: null, // {type:'roll'|'move'|'skip', ...} — for animation/toasts
  result: null, // game:over / game:aborted payload
  turnTimeoutMs: 30000, // how long a player has to act before auto-skip
  presence: { online: 0, waiting: 0, playing: 0 }, // live player counts
  // Explicit intent to start a practice game. This must NOT be derived from
  // "guest is idle" — cancelling makes a guest idle, which would instantly
  // re-queue them and make Cancel look broken.
  pendingPractice: false,
  connected: false, // live socket status, so the UI can disable actions
  error: null,

  setConnected(connected) {
    set({ connected });
  },

  requestPractice() {
    set({ pendingPractice: true });
  },
  clearPendingPractice() {
    set({ pendingPractice: false });
  },

  setPresence(presence) {
    set({ presence });
  },

  setRoom(room) {
    set({ room, status: room?.status === 'playing' ? 'playing' : room ? 'waiting' : 'idle' });
  },

  applySync(snap) {
    if (!snap) return set({ status: 'idle', room: null, state: null, commitment: null });
    set({
      room: snap.room,
      state: snap.state,
      commitment: snap.commitment,
      turnTimeoutMs: snap.turnTimeoutMs || 30000,
      status: snap.state ? (snap.state.status === 'finished' ? 'finished' : 'playing') : 'waiting',
    });
  },

  onGameStart({ room, state, commitment, turnTimeoutMs }) {
    set({ room, state, commitment, turnTimeoutMs: turnTimeoutMs || 30000, status: 'playing', result: null, lastRoll: null, lastRoller: null, lastEvent: null });
  },

  onRolled({ die, result, state, roomId }) {
    set((s) =>
      stale(s, roomId)
        ? s
        : { state, lastRoll: die, lastRoller: s.state?.currentPlayerId ?? null, lastEvent: { type: 'roll', die, result } },
    );
  },

  onMoved({ result, state, roomId }) {
    set((s) => (stale(s, roomId) ? s : { state, lastEvent: { type: 'move', result } }));
  },

  onState({ state, note, roomId }) {
    set((s) => (stale(s, roomId) ? s : { state, lastEvent: note || null }));
  },

  onOver(payload) {
    set((s) => (stale(s, payload.roomId) ? s : { status: 'finished', state: payload.state, result: payload }));
  },

  onAborted(payload) {
    set((s) => (stale(s, payload.roomId) ? s : { status: 'finished', result: { aborted: true, ...payload } }));
  },

  setError(error) {
    set({ error });
  },
  clearError() {
    set({ error: null });
  },

  reset() {
    set({
      status: 'idle',
      room: null,
      state: null,
      commitment: null,
      result: null,
      lastRoll: null,
      lastRoller: null,
      lastEvent: null,
    });
  },
}));
