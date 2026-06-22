import { nanoid } from 'nanoid';

// In-memory store (default backend; used by the test suite). Methods are async
// to match the storage interface the MySQL backend implements.
export class MemoryStore {
  constructor() {
    this.users = new Map();
    this.usersByProvider = new Map();
    this.refreshSessions = new Map();
    this.games = new Map();
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
