import { nanoid } from 'nanoid';
import { newReferralCode } from '../util/referral.js';

// In-memory store (default backend; used by the test suite). Methods are async
// to match the storage interface the MySQL backend implements.
export class MemoryStore {
  constructor() {
    this.users = new Map();
    this.usersByProvider = new Map();
    this.refreshSessions = new Map();
    this.games = new Map();
    this.gamePlayers = []; // one entry per player per finished game
    this.tournaments = new Map(); // id -> tournament
    this.withdrawals = new Map(); // id -> withdrawal request
    this.coinOrders = new Map(); // id -> coin shop order
    this.pushSubs = new Map(); // endpoint -> subscription
    this.claims = new Map(); // id -> payment claim
    this.tournamentEntries = []; // { tournamentId, userId, seed, paymentRef, addedBy, joinedAt, placement }
  }

  _providerKey(provider, providerId) {
    return `${provider}:${providerId}`;
  }

  async getUser(id) {
    return this.users.get(id) || null;
  }

  async findUserByProvider(provider, providerId) {
    const id = this.usersByProvider.get(this._providerKey(provider, providerId));
    return id ? this.users.get(id) : null;
  }

  async createUser({ provider, providerId, email, name, picture }) {
    const id = nanoid(16);
    const user = {
      id,
      provider,
      providerId,
      email: email || null,
      name: name || 'Player',
      picture: picture || null,
      createdAt: Date.now(),
      lastDailyBonusAt: null,
      gamesPlayed: 0,
      gamesWon: 0,
      referralCode: newReferralCode(),
      referredBy: null,
    };
    this.users.set(id, user);
    this.usersByProvider.set(this._providerKey(provider, providerId), id);
    return user;
  }

  async findUserByReferralCode(code) {
    if (!code) return null;
    const wanted = String(code).trim().toUpperCase();
    for (const u of this.users.values()) {
      if (u.referralCode === wanted) return u;
    }
    return null;
  }

  async setReferredBy(userId, referrerId) {
    const u = this.users.get(userId);
    if (u) u.referredBy = referrerId;
  }

  async countReferrals(userId) {
    let n = 0;
    for (const u of this.users.values()) if (u.referredBy === userId) n++;
    return n;
  }

  async saveRefreshSession(jti, userId, expiresAt) {
    this.refreshSessions.set(jti, { userId, expiresAt });
  }

  async getRefreshSession(jti) {
    return this.refreshSessions.get(jti) || null;
  }

  async revokeRefreshSession(jti) {
    this.refreshSessions.delete(jti);
  }

  async recordGame(summary) {
    this.games.set(summary.id, summary);
    const endedAt = summary.endedAt || Date.now();
    for (const p of summary.players || []) {
      const isWinner = p.userId === summary.winnerId;
      const payout = isWinner ? summary.payout || 0 : 0;
      this.gamePlayers.push({
        gameId: summary.id,
        userId: p.userId,
        name: p.name || null,
        color: p.color || null,
        isWinner,
        stake: summary.stake || 0,
        payout,
        net: payout - (summary.stake || 0),
        endedAt,
      });
    }
  }

  // ── tournaments ──
  async createTournament(t) {
    this.tournaments.set(t.id, { ...t });
    return this.tournaments.get(t.id);
  }

  async getTournament(id) {
    return this.tournaments.get(id) || null;
  }

  async updateTournament(id, patch) {
    const t = this.tournaments.get(id);
    if (!t) return null;
    Object.assign(t, patch);
    return t;
  }

  async listTournaments({ status = null, limit = 50 } = {}) {
    return [...this.tournaments.values()]
      .filter((t) => !status || t.status === status)
      .sort((a, b) => (b.startsAt || b.createdAt) - (a.startsAt || a.createdAt))
      .slice(0, limit);
  }

  async addTournamentEntry(entry) {
    if (this.tournamentEntries.some((e) => e.tournamentId === entry.tournamentId && e.userId === entry.userId)) {
      return null; // already entered
    }
    this.tournamentEntries.push({ ...entry });
    return entry;
  }

  async removeTournamentEntry(tournamentId, userId) {
    const before = this.tournamentEntries.length;
    this.tournamentEntries = this.tournamentEntries.filter(
      (e) => !(e.tournamentId === tournamentId && e.userId === userId),
    );
    return before !== this.tournamentEntries.length;
  }

  async listTournamentEntries(tournamentId) {
    return this.tournamentEntries
      .filter((e) => e.tournamentId === tournamentId)
      .sort((a, b) => a.seed - b.seed)
      .map((e) => ({ ...e, name: this.users.get(e.userId)?.name || null }));
  }

  // Removes the tournament and its seat list. Payment claims are deliberately
  // NOT deleted: they are the record that money changed hands, and their UTRs
  // are what stop the same transaction reference being reused.
  async deleteTournament(id) {
    if (!this.tournaments.has(id)) return false;
    this.tournaments.delete(id);
    this.tournamentEntries = this.tournamentEntries.filter((e) => e.tournamentId !== id);
    return true;
  }

  // Paid entries per tournament, for a whole page of tournaments at once.
  async countEntriesByTournament(ids = []) {
    const want = new Set(ids);
    const out = {};
    for (const id of want) out[id] = 0;
    for (const e of this.tournamentEntries) {
      if (want.has(e.tournamentId)) out[e.tournamentId] += 1;
    }
    return out;
  }

  async listTournamentsForUser(userId, limit = 20) {
    const ids = this.tournamentEntries.filter((e) => e.userId === userId).map((e) => e.tournamentId);
    return [...this.tournaments.values()]
      .filter((t) => ids.includes(t.id))
      .sort((a, b) => (b.startsAt || b.createdAt) - (a.startsAt || a.createdAt))
      .slice(0, limit);
  }

  // ── push subscriptions ──
  async savePushSubscription(sub) {
    this.pushSubs.set(sub.endpoint, { ...sub });
    return sub;
  }

  async deletePushSubscription(endpoint) {
    return this.pushSubs.delete(endpoint);
  }

  async listPushSubscriptions(userId) {
    return [...this.pushSubs.values()].filter((s) => s.userId === userId);
  }

  async listAllPushUserIds() {
    return [...new Set([...this.pushSubs.values()].map((s) => s.userId))];
  }

  // ── payment claims ──
  async createClaim(claim) {
    // The UTR is unique across every claim ever made — a transaction reference
    // can only ever buy one entry.
    for (const c of this.claims.values()) {
      if (c.utr === claim.utr) return null;
    }
    this.claims.set(claim.id, { ...claim });
    return this.claims.get(claim.id);
  }

  async getClaim(id) {
    return this.claims.get(id) || null;
  }

  async updateClaim(id, patch) {
    const c = this.claims.get(id);
    if (!c) return null;
    Object.assign(c, patch);
    return c;
  }

  async listClaims({ status = null, tournamentId = null, purpose = null, limit = 100 } = {}) {
    return [...this.claims.values()]
      .filter(
        (c) =>
          (!status || c.status === status) &&
          (!tournamentId || c.tournamentId === tournamentId) &&
          (!purpose || (c.purpose || 'tournament') === purpose),
      )
      .sort((a, b) => a.createdAt - b.createdAt) // oldest first — a review queue
      .slice(0, limit)
      .map((c) => ({
        ...c,
        userName: this.users.get(c.userId)?.name || null,
        tournamentTitle: this.tournaments.get(c.tournamentId)?.title || null,
      }));
  }

  // A player's outstanding deposit request, if any.
  async getActiveDepositClaim(userId) {
    for (const c of this.claims.values()) {
      if (c.userId === userId && c.purpose === 'deposit' && c.status === 'pending') return c;
    }
    return null;
  }

  // ── withdrawals ──
  async createWithdrawal(w) {
    this.withdrawals.set(w.id, { ...w });
    return this.withdrawals.get(w.id);
  }

  async getWithdrawal(id) {
    return this.withdrawals.get(id) || null;
  }

  async updateWithdrawal(id, patch) {
    const w = this.withdrawals.get(id);
    if (!w) return null;
    Object.assign(w, patch);
    return w;
  }

  async listWithdrawals({ status = null, userId = null, limit = 100 } = {}) {
    return [...this.withdrawals.values()]
      .filter((w) => (!status || w.status === status) && (!userId || w.userId === userId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((w) => ({ ...w, userName: this.users.get(w.userId)?.name || null }));
  }

  // The player's current claim for a tournament (pending or approved).
  async getActiveClaim(tournamentId, userId) {
    for (const c of this.claims.values()) {
      if (c.tournamentId === tournamentId && c.userId === userId && c.status !== 'rejected') return c;
    }
    return null;
  }

  async getUserGames(userId, limit = 20) {
    const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    return this.gamePlayers
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, lim)
      .map((r) => {
        const g = this.games.get(r.gameId);
        return {
          gameId: r.gameId,
          stake: r.stake,
          pot: g?.pot ?? null,
          isWinner: r.isWinner,
          payout: r.payout,
          net: r.net,
          endedAt: r.endedAt,
          players: (g?.players || []).map((p) => ({ userId: p.userId, name: p.name || null, color: p.color || null })),
        };
      });
  }

  async getLeaderboard({ limit = 20, since = null } = {}) {
    const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const agg = new Map();
    for (const r of this.gamePlayers) {
      if (since && r.endedAt < since) continue;
      const a = agg.get(r.userId) || { userId: r.userId, games: 0, wins: 0, net: 0 };
      a.games += 1;
      if (r.isWinner) a.wins += 1;
      a.net += r.net;
      agg.set(r.userId, a);
    }
    return [...agg.values()]
      .map((a) => ({ ...a, name: this.users.get(a.userId)?.name || null }))
      .sort((x, y) => y.net - x.net || y.wins - x.wins)
      .slice(0, lim)
      .map((a, i) => ({ rank: i + 1, ...a }));
  }

  async incrementStats(userId, won) {
    const u = this.users.get(userId);
    if (u) {
      u.gamesPlayed += 1;
      if (won) u.gamesWon += 1;
    }
  }

  async setDailyBonusClaimed(userId, timestamp) {
    const u = this.users.get(userId);
    if (u) u.lastDailyBonusAt = timestamp;
  }

  // ── coin shop orders ──
  async createCoinOrder(o) {
    this.coinOrders.set(o.id, { ...o });
    return { ...this.coinOrders.get(o.id) };
  }

  async getCoinOrder(id) {
    const o = this.coinOrders.get(id);
    return o ? { ...o } : null;
  }

  async updateCoinOrder(id, patch) {
    const o = this.coinOrders.get(id);
    if (!o) return null;
    Object.assign(o, patch, { updatedAt: Date.now() });
    return { ...o };
  }

  async listCoinOrders({ status = null, userId = null, since = null, until = null, limit = 50 } = {}) {
    return [...this.coinOrders.values()]
      .filter((o) => (!status || o.status === status) && (!userId || o.userId === userId) && (!since || o.createdAt >= since) && (!until || o.createdAt < until))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((o) => ({ ...o }));
  }
}
