import { nanoid } from 'nanoid';

// ──────────────────────────────────────────────────────────────────────────
// In-memory data store.
//
// This is deliberately behind a small class so the persistence layer can later
// be swapped for PostgreSQL/Redis WITHOUT touching game or wallet logic — those
// modules only ever call these methods, never reach into a database directly.
//
// For real money you'll replace this with a transactional DB. The method shapes
// (findOrCreate, revoke session, record game) are already DB-friendly.
// ──────────────────────────────────────────────────────────────────────────
export class MemoryStore {
  constructor() {
    this.users = new Map(); // userId -> user
    this.usersByProvider = new Map(); // "provider:providerId" -> userId
    this.refreshSessions = new Map(); // jti -> { userId, expiresAt }
    this.games = new Map(); // gameId -> finished-game summary (audit trail)
  }

  _providerKey(provider, providerId) {
    return `${provider}:${providerId}`;
  }

  getUser(id) {
    return this.users.get(id) || null;
  }

  findUserByProvider(provider, providerId) {
    const id = this.usersByProvider.get(this._providerKey(provider, providerId));
    return id ? this.users.get(id) : null;
  }

  createUser({ provider, providerId, email, name, picture }) {
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

  // ── refresh-token sessions (so we can revoke on logout / rotate) ──
  saveRefreshSession(jti, userId, expiresAt) {
    this.refreshSessions.set(jti, { userId, expiresAt });
  }

  getRefreshSession(jti) {
    return this.refreshSessions.get(jti) || null;
  }

  revokeRefreshSession(jti) {
    this.refreshSessions.delete(jti);
  }

  // ── finished-game audit trail ──
  recordGame(summary) {
    this.games.set(summary.id, summary);
  }
}

export const store = new MemoryStore();
