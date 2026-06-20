import { create } from 'zustand';

// Mirror of the authoritative server game state. The client NEVER computes
// game logic — it only reflects what the server broadcasts and sends intents
// back. Every field here arrives from a socket event.
export const useGame = create((set) => ({
  status: 'idle', // idle | waiting | playing | finished
  room: null,
  state: null, // engine.getState() snapshot
  commitment: null, // provably-fair commitment (serverSeedHash, clientSeed)
  lastRoll: null,
  lastEvent: null, // {type:'roll'|'move'|'skip', ...} — for animation/toasts
  result: null, // game:over / game:aborted payload
  error: null,

  setRoom(room) {
    set({ room, status: room?.status === 'playing' ? 'playing' : room ? 'waiting' : 'idle' });
  },

  applySync(snap) {
    if (!snap) return set({ status: 'idle', room: null, state: null, commitment: null });
    set({
      room: snap.room,
      state: snap.state,
      commitment: snap.commitment,
      status: snap.state ? (snap.state.status === 'finished' ? 'finished' : 'playing') : 'waiting',
    });
  },

  onGameStart({ room, state, commitment }) {
    set({ room, state, commitment, status: 'playing', result: null, lastRoll: null, lastEvent: null });
  },

  onRolled({ die, result, state }) {
    set({ state, lastRoll: die, lastEvent: { type: 'roll', die, result } });
  },

  onMoved({ result, state }) {
    set({ state, lastEvent: { type: 'move', result } });
  },

  onState({ state, note }) {
    set({ state, lastEvent: note || null });
  },

  onOver(payload) {
    set({ status: 'finished', state: payload.state, result: payload });
  },

  onAborted(payload) {
    set({ status: 'finished', result: { aborted: true, ...payload } });
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
      lastEvent: null,
    });
  },
}));
