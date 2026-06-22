import { MemoryStore } from './MemoryStore.js';

// Facade over the active store backend. Defaults to in-memory (tests / dev);
// `setStoreBackend` swaps in the MySQL implementation at startup. Modules keep
// importing `{ store }` from here regardless of which backend is active.
let backend = new MemoryStore();

export function setStoreBackend(impl) {
  backend = impl;
}

export const store = {
  getUser: (...a) => backend.getUser(...a),
  findUserByProvider: (...a) => backend.findUserByProvider(...a),
  createUser: (...a) => backend.createUser(...a),
  saveRefreshSession: (...a) => backend.saveRefreshSession(...a),
  getRefreshSession: (...a) => backend.getRefreshSession(...a),
  revokeRefreshSession: (...a) => backend.revokeRefreshSession(...a),
  recordGame: (...a) => backend.recordGame(...a),
  incrementStats: (...a) => backend.incrementStats(...a),
  setDailyBonusClaimed: (...a) => backend.setDailyBonusClaimed(...a),
};
