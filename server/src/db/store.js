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
  getUserGames: (...a) => backend.getUserGames(...a),
  getLeaderboard: (...a) => backend.getLeaderboard(...a),
  findUserByReferralCode: (...a) => backend.findUserByReferralCode(...a),
  savePushSubscription: (...a) => backend.savePushSubscription(...a),
  deletePushSubscription: (...a) => backend.deletePushSubscription(...a),
  listPushSubscriptions: (...a) => backend.listPushSubscriptions(...a),
  listAllPushUserIds: (...a) => backend.listAllPushUserIds(...a),
  createClaim: (...a) => backend.createClaim(...a),
  getClaim: (...a) => backend.getClaim(...a),
  updateClaim: (...a) => backend.updateClaim(...a),
  listClaims: (...a) => backend.listClaims(...a),
  getActiveClaim: (...a) => backend.getActiveClaim(...a),
  getActiveDepositClaim: (...a) => backend.getActiveDepositClaim(...a),
  createWithdrawal: (...a) => backend.createWithdrawal(...a),
  getWithdrawal: (...a) => backend.getWithdrawal(...a),
  updateWithdrawal: (...a) => backend.updateWithdrawal(...a),
  listWithdrawals: (...a) => backend.listWithdrawals(...a),
  createTournament: (...a) => backend.createTournament(...a),
  getTournament: (...a) => backend.getTournament(...a),
  updateTournament: (...a) => backend.updateTournament(...a),
  listTournaments: (...a) => backend.listTournaments(...a),
  deleteTournament: (...a) => backend.deleteTournament(...a),
  countEntriesByTournament: (...a) => backend.countEntriesByTournament(...a),
  addTournamentEntry: (...a) => backend.addTournamentEntry(...a),
  removeTournamentEntry: (...a) => backend.removeTournamentEntry(...a),
  listTournamentEntries: (...a) => backend.listTournamentEntries(...a),
  listTournamentsForUser: (...a) => backend.listTournamentsForUser(...a),
  setReferredBy: (...a) => backend.setReferredBy(...a),
  countReferrals: (...a) => backend.countReferrals(...a),
  createCoinOrder: (...a) => backend.createCoinOrder(...a),
  getCoinOrder: (...a) => backend.getCoinOrder(...a),
  updateCoinOrder: (...a) => backend.updateCoinOrder(...a),
  listCoinOrders: (...a) => backend.listCoinOrders(...a),
};
