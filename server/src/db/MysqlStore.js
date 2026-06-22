import { nanoid } from 'nanoid';

// Map a DB row (snake_case) to the user shape the rest of the app expects.
const mapUser = (r) =>
  r
    ? {
        id: r.id,
        provider: r.provider,
        providerId: r.provider_id,
        email: r.email,
        name: r.name,
        picture: r.picture,
        createdAt: Number(r.created_at),
        lastDailyBonusAt: r.last_daily_bonus_at == null ? null : Number(r.last_daily_bonus_at),
        gamesPlayed: r.games_played,
        gamesWon: r.games_won,
      }
    : null;

export class MysqlStore {
  constructor(pool) {
    this.pool = pool;
  }

  async getUser(id) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE id=?', [id]);
    return mapUser(rows[0]);
  }

  async findUserByProvider(provider, providerId) {
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE provider=? AND provider_id=?', [provider, providerId]);
    return mapUser(rows[0]);
  }

  async createUser({ provider, providerId, email, name, picture }) {
    const id = nanoid(16);
    const createdAt = Date.now();
    try {
      await this.pool.execute(
        `INSERT INTO users(id, provider, provider_id, email, name, picture, created_at, games_played, games_won)
         VALUES(?,?,?,?,?,?,?,0,0)`,
        [id, provider, providerId, email || null, name || 'Player', picture || null, createdAt],
      );
    } catch (e) {
      // Lost a race to create the same provider account — return the winner.
      if (e.code === 'ER_DUP_ENTRY') return this.findUserByProvider(provider, providerId);
      throw e;
    }
    return {
      id,
      provider,
      providerId,
      email: email || null,
      name: name || 'Player',
      picture: picture || null,
      createdAt,
      lastDailyBonusAt: null,
      gamesPlayed: 0,
      gamesWon: 0,
    };
  }

  async saveRefreshSession(jti, userId, expiresAt) {
    await this.pool.execute(
      `INSERT INTO refresh_sessions(jti, user_id, expires_at) VALUES(?,?,?)
       ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), expires_at=VALUES(expires_at)`,
      [jti, userId, expiresAt],
    );
  }

  async getRefreshSession(jti) {
    const [rows] = await this.pool.execute('SELECT user_id, expires_at FROM refresh_sessions WHERE jti=?', [jti]);
    return rows.length ? { userId: rows[0].user_id, expiresAt: Number(rows[0].expires_at) } : null;
  }

  async revokeRefreshSession(jti) {
    await this.pool.execute('DELETE FROM refresh_sessions WHERE jti=?', [jti]);
  }

  async recordGame(summary) {
    await this.pool.execute(
      `INSERT INTO games(id, data, ended_at) VALUES(?,?,?)
       ON DUPLICATE KEY UPDATE data=VALUES(data), ended_at=VALUES(ended_at)`,
      [summary.id, JSON.stringify(summary), summary.endedAt || Date.now()],
    );
  }

  async incrementStats(userId, won) {
    await this.pool.execute('UPDATE users SET games_played=games_played+1, games_won=games_won+? WHERE id=?', [won ? 1 : 0, userId]);
  }

  async setDailyBonusClaimed(userId, timestamp) {
    await this.pool.execute('UPDATE users SET last_daily_bonus_at=? WHERE id=?', [timestamp, userId]);
  }
}
