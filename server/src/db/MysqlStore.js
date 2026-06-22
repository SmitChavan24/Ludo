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
    const endedAt = summary.endedAt || Date.now();
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `INSERT INTO games(id, data, ended_at) VALUES(?,?,?)
         ON DUPLICATE KEY UPDATE data=VALUES(data), ended_at=VALUES(ended_at)`,
        [summary.id, JSON.stringify(summary), endedAt],
      );

      const players = summary.players || [];
      if (players.length) {
        const rows = players.map((p) => {
          const isWinner = p.userId === summary.winnerId ? 1 : 0;
          const payout = isWinner ? summary.payout || 0 : 0;
          return [summary.id, p.userId, p.name || null, p.color || null, isWinner, summary.stake || 0, payout, payout - (summary.stake || 0), endedAt];
        });
        await conn.query(
          `INSERT INTO game_players(game_id, user_id, name, color, is_winner, stake, payout, net, ended_at) VALUES ?
           ON DUPLICATE KEY UPDATE is_winner=VALUES(is_winner), payout=VALUES(payout), net=VALUES(net)`,
          [rows],
        );
      }
      await conn.commit();
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      conn.release();
    }
  }

  // A player's recent games, newest first.
  async getUserGames(userId, limit = 20) {
    const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const [rows] = await this.pool.query(
      `SELECT gp.game_id, gp.is_winner, gp.stake, gp.payout, gp.net, gp.ended_at, g.data
       FROM game_players gp JOIN games g ON g.id = gp.game_id
       WHERE gp.user_id=? ORDER BY gp.ended_at DESC LIMIT ${lim}`,
      [userId],
    );
    return rows.map((r) => {
      const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data || {};
      return {
        gameId: r.game_id,
        stake: Number(r.stake),
        pot: data.pot ?? null,
        isWinner: !!r.is_winner,
        payout: Number(r.payout),
        net: Number(r.net),
        endedAt: Number(r.ended_at),
        players: (data.players || []).map((p) => ({ userId: p.userId, name: p.name || null, color: p.color || null })),
      };
    });
  }

  // Top players by net coins won (optionally within a time window).
  async getLeaderboard({ limit = 20, since = null } = {}) {
    const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const where = since ? 'WHERE gp.ended_at >= ?' : '';
    const params = since ? [since] : [];
    const [rows] = await this.pool.query(
      `SELECT u.id, u.name, COUNT(*) AS games, SUM(gp.is_winner) AS wins, SUM(gp.net) AS net
       FROM game_players gp JOIN users u ON u.id = gp.user_id
       ${where}
       GROUP BY u.id, u.name ORDER BY net DESC, wins DESC LIMIT ${lim}`,
      params,
    );
    return rows.map((r, i) => ({
      rank: i + 1,
      userId: r.id,
      name: r.name,
      games: Number(r.games),
      wins: Number(r.wins),
      net: Number(r.net),
    }));
  }

  async incrementStats(userId, won) {
    await this.pool.execute('UPDATE users SET games_played=games_played+1, games_won=games_won+? WHERE id=?', [won ? 1 : 0, userId]);
  }

  async setDailyBonusClaimed(userId, timestamp) {
    await this.pool.execute('UPDATE users SET last_daily_bonus_at=? WHERE id=?', [timestamp, userId]);
  }
}
