import { nanoid } from 'nanoid';

// In-memory store (default backend; used by the test suite). Methods are async
// to match the storage interface the MySQL backend implements.
export class MemoryStore {
  constructor() {
    this.users = new Map();
    this.usersByProvider = new Map();
    this.refreshSessions = new Map();
    this.games = new Map();
    this.gamePlayers = []; // one entry per player per finished game
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
    };
    this.users.set(id, user);
    this.usersByProvider.set(this._providerKey(provider, providerId), id);
    return user;
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
}
