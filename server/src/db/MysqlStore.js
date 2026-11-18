import { nanoid } from 'nanoid';
import { newReferralCode } from '../util/referral.js';

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
        referralCode: r.referral_code || null,
        referredBy: r.referred_by || null,
      }
    : null;


// Map a tournament row to the app-level shape.
const mapTournament = (r) =>
  r
    ? {
        id: r.id,
        title: r.title,
        status: r.status,
        entryType: r.entry_type,
        entryFeeCoins: Number(r.entry_fee_coins),
        entryFeeInr: Number(r.entry_fee_inr),
        prizeText: r.prize_text,
        prizeCoins: Number(r.prize_coins),
        maxPlayers: r.max_players,
        startsAt: r.starts_at == null ? null : Number(r.starts_at),
        lobbyOpensAt: r.lobby_opens_at == null ? null : Number(r.lobby_opens_at),
        createdAt: Number(r.created_at),
        finishedAt: r.finished_at == null ? null : Number(r.finished_at),
        winnerId: r.winner_id,
        rakeBips: Number(r.rake_bips || 0),
        payoutSplit: String(r.payout_split || '100').split(',').map(Number).filter(Boolean),
        autoStart: !!r.auto_start,
        bracket: typeof r.bracket === 'string' ? JSON.parse(r.bracket) : r.bracket,
      }
    : null;


const mapClaim = (r) =>
  r
    ? {
        id: r.id,
        tournamentId: r.tournament_id,
        userId: r.user_id,
        utr: r.utr,
        amountInr: Number(r.amount_inr),
        note: r.note,
        status: r.status,
        createdAt: Number(r.created_at),
        reviewedAt: r.reviewed_at == null ? null : Number(r.reviewed_at),
        reviewedBy: r.reviewed_by,
        reviewNote: r.review_note,
        purpose: r.purpose || 'tournament',
        userName: r.user_name ?? undefined,
        tournamentTitle: r.tournament_title ?? undefined,
      }
    : null;

const mapWithdrawal = (r) =>
  r
    ? {
        id: r.id,
        userId: r.user_id,
        amountInr: Number(r.amount_inr),
        upiId: r.upi_id,
        status: r.status,
        createdAt: Number(r.created_at),
        reviewedAt: r.reviewed_at == null ? null : Number(r.reviewed_at),
        reviewedBy: r.reviewed_by,
        paymentRef: r.payment_ref,
        note: r.note,
        userName: r.user_name ?? undefined,
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
    let referralCode = newReferralCode();
    // Retry a few times in the vanishingly unlikely event of a code collision.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.pool.execute(
          `INSERT INTO users(id, provider, provider_id, email, name, picture, created_at, games_played, games_won, referral_code)
           VALUES(?,?,?,?,?,?,?,0,0,?)`,
          [id, provider, providerId, email || null, name || 'Player', picture || null, createdAt, referralCode],
        );
        break;
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') throw e;
        // Which unique key collided? If the account already exists, return it.
        const existing = await this.findUserByProvider(provider, providerId);
        if (existing) return existing;
        if (attempt >= 4) throw e;
        referralCode = newReferralCode(); // must have been the referral code
      }
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
      referralCode,
      referredBy: null,
    };
  }

  async findUserByReferralCode(code) {
    if (!code) return null;
    const [rows] = await this.pool.execute('SELECT * FROM users WHERE referral_code=?', [String(code).toUpperCase()]);
    return mapUser(rows[0]);
  }

  async setReferredBy(userId, referrerId) {
    await this.pool.execute('UPDATE users SET referred_by=? WHERE id=?', [referrerId, userId]);
  }

  async countReferrals(userId) {
    const [rows] = await this.pool.execute('SELECT COUNT(*) AS n FROM users WHERE referred_by=?', [userId]);
    return Number(rows[0].n);
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

  // ── tournaments ──
  async createTournament(t) {
    await this.pool.execute(
      `INSERT INTO tournaments(id,title,status,entry_type,entry_fee_coins,entry_fee_inr,prize_text,prize_coins,
                               max_players,starts_at,lobby_opens_at,created_at,rake_bips,payout_split,auto_start,bracket)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t.id, t.title, t.status, t.entryType, t.entryFeeCoins || 0, t.entryFeeInr || 0, t.prizeText || null,
       t.prizeCoins || 0, t.maxPlayers, t.startsAt || null, t.lobbyOpensAt || null, t.createdAt, t.rakeBips || 0,
       (t.payoutSplit || [100]).join(','), t.autoStart === false ? 0 : 1,
       t.bracket ? JSON.stringify(t.bracket) : null],
    );
    return t;
  }

  async getTournament(id) {
    const [rows] = await this.pool.execute('SELECT * FROM tournaments WHERE id=?', [id]);
    return mapTournament(rows[0]);
  }

  async updateTournament(id, patch) {
    const cols = {
      title: 'title', status: 'status', entryType: 'entry_type', entryFeeCoins: 'entry_fee_coins',
      entryFeeInr: 'entry_fee_inr', prizeText: 'prize_text', prizeCoins: 'prize_coins',
      maxPlayers: 'max_players', startsAt: 'starts_at', lobbyOpensAt: 'lobby_opens_at', finishedAt: 'finished_at',
      winnerId: 'winner_id', bracket: 'bracket', rakeBips: 'rake_bips',
      payoutSplit: 'payout_split', autoStart: 'auto_start',
    };
    const sets = [];
    const vals = [];
    for (const [key, col] of Object.entries(cols)) {
      if (patch[key] === undefined) continue;
      sets.push(`${col}=?`);
      let v = patch[key];
      if (key === 'bracket') v = JSON.stringify(v);
      else if (key === 'payoutSplit') v = (v || [100]).join(',');
      else if (key === 'autoStart') v = v ? 1 : 0;
      vals.push(v);
    }
    if (!sets.length) return this.getTournament(id);
    vals.push(id);
    await this.pool.execute(`UPDATE tournaments SET ${sets.join(', ')} WHERE id=?`, vals);
    return this.getTournament(id);
  }

  async listTournaments({ status = null, limit = 50 } = {}) {
    const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 50));
    const where = status ? 'WHERE status=?' : '';
    const [rows] = await this.pool.query(
      `SELECT * FROM tournaments ${where} ORDER BY COALESCE(starts_at, created_at) DESC LIMIT ${lim}`,
      status ? [status] : [],
    );
    return rows.map(mapTournament);
  }

  async addTournamentEntry(entry) {
    try {
      await this.pool.execute(
        `INSERT INTO tournament_entries(tournament_id,user_id,seed,payment_ref,added_by,joined_at)
         VALUES(?,?,?,?,?,?)`,
        [entry.tournamentId, entry.userId, entry.seed, entry.paymentRef || null, entry.addedBy || null, entry.joinedAt],
      );
      return entry;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return null; // already entered
      throw e;
    }
  }

  async removeTournamentEntry(tournamentId, userId) {
    const [res] = await this.pool.execute(
      'DELETE FROM tournament_entries WHERE tournament_id=? AND user_id=?', [tournamentId, userId],
    );
    return res.affectedRows > 0;
  }

  async listTournamentEntries(tournamentId) {
    const [rows] = await this.pool.execute(
      `SELECT te.*, u.name FROM tournament_entries te
       LEFT JOIN users u ON u.id = te.user_id
       WHERE te.tournament_id=? ORDER BY te.seed`,
      [tournamentId],
    );
    return rows.map((r) => ({
      tournamentId: r.tournament_id,
      userId: r.user_id,
      name: r.name || null,
      seed: r.seed,
      paymentRef: r.payment_ref,
      addedBy: r.added_by,
      joinedAt: Number(r.joined_at),
      placement: r.placement,
    }));
  }

  // See MemoryStore.deleteTournament — claims are kept on purpose. The claims
  // list LEFT JOINs tournaments, so they still render once the parent is gone.
  async deleteTournament(id) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('DELETE FROM tournament_entries WHERE tournament_id=?', [id]);
      const [res] = await conn.execute('DELETE FROM tournaments WHERE id=?', [id]);
      await conn.commit();
      return res.affectedRows > 0;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // One grouped count for the whole page rather than a query per tournament.
  async countEntriesByTournament(ids = []) {
    const out = {};
    for (const id of ids) out[id] = 0;
    if (!ids.length) return out;
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await this.pool.query(
      `SELECT tournament_id, COUNT(*) AS n FROM tournament_entries
       WHERE tournament_id IN (${placeholders}) GROUP BY tournament_id`,
      ids,
    );
    for (const r of rows) out[r.tournament_id] = Number(r.n);
    return out;
  }

  async listTournamentsForUser(userId, limit = 20) {
    const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const [rows] = await this.pool.query(
      `SELECT t.* FROM tournaments t
       JOIN tournament_entries te ON te.tournament_id = t.id
       WHERE te.user_id=? ORDER BY COALESCE(t.starts_at, t.created_at) DESC LIMIT ${lim}`,
      [userId],
    );
    return rows.map(mapTournament);
  }


  // ── push subscriptions ──
  async savePushSubscription(sub) {
    await this.pool.execute(
      `INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth,created_at) VALUES(?,?,?,?,?)
       ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), p256dh=VALUES(p256dh), auth=VALUES(auth)`,
      [sub.endpoint, sub.userId, sub.p256dh, sub.auth, sub.createdAt],
    );
    return sub;
  }

  async deletePushSubscription(endpoint) {
    const [res] = await this.pool.execute('DELETE FROM push_subscriptions WHERE endpoint=?', [endpoint]);
    return res.affectedRows > 0;
  }

  async listPushSubscriptions(userId) {
    const [rows] = await this.pool.execute('SELECT * FROM push_subscriptions WHERE user_id=?', [userId]);
    return rows.map((r) => ({ endpoint: r.endpoint, userId: r.user_id, p256dh: r.p256dh, auth: r.auth }));
  }

  async listAllPushUserIds() {
    const [rows] = await this.pool.query('SELECT DISTINCT user_id FROM push_subscriptions');
    return rows.map((r) => r.user_id);
  }

  // ── payment claims ──
  async createClaim(claim) {
    try {
      await this.pool.execute(
        `INSERT INTO tournament_claims(id,tournament_id,purpose,user_id,utr,amount_inr,note,status,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [claim.id, claim.tournamentId || null, claim.purpose || 'tournament', claim.userId, claim.utr,
         claim.amountInr || 0, claim.note || null, claim.status, claim.createdAt],
      );
      return claim;
    } catch (e) {
      // The unique index on `utr` is the duplicate-payment guard.
      if (e.code === 'ER_DUP_ENTRY') return null;
      throw e;
    }
  }

  async getClaim(id) {
    const [rows] = await this.pool.execute('SELECT * FROM tournament_claims WHERE id=?', [id]);
    return mapClaim(rows[0]);
  }

  async updateClaim(id, patch) {
    const cols = { status: 'status', reviewedAt: 'reviewed_at', reviewedBy: 'reviewed_by', reviewNote: 'review_note' };
    const sets = [];
    const vals = [];
    for (const [key, col] of Object.entries(cols)) {
      if (patch[key] === undefined) continue;
      sets.push(`${col}=?`);
      vals.push(patch[key]);
    }
    if (!sets.length) return this.getClaim(id);
    vals.push(id);
    await this.pool.execute(`UPDATE tournament_claims SET ${sets.join(', ')} WHERE id=?`, vals);
    return this.getClaim(id);
  }

  async listClaims({ status = null, tournamentId = null, purpose = null, limit = 100 } = {}) {
    const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 100));
    const where = [];
    const params = [];
    if (status) { where.push('c.status=?'); params.push(status); }
    if (tournamentId) { where.push('c.tournament_id=?'); params.push(tournamentId); }
    if (purpose) { where.push('c.purpose=?'); params.push(purpose); }
    const [rows] = await this.pool.query(
      `SELECT c.*, u.name AS user_name, t.title AS tournament_title
       FROM tournament_claims c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN tournaments t ON t.id = c.tournament_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY c.created_at ASC LIMIT ${lim}`,
      params,
    );
    return rows.map(mapClaim);
  }

  async getActiveClaim(tournamentId, userId) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM tournament_claims
       WHERE tournament_id=? AND user_id=? AND status <> 'rejected' LIMIT 1`,
      [tournamentId, userId],
    );
    return mapClaim(rows[0]);
  }

  async getActiveDepositClaim(userId) {
    const [rows] = await this.pool.execute(
      "SELECT * FROM tournament_claims WHERE user_id=? AND purpose='deposit' AND status='pending' LIMIT 1",
      [userId],
    );
    return mapClaim(rows[0]);
  }

  // ── withdrawals ──
  async createWithdrawal(w) {
    await this.pool.execute(
      `INSERT INTO withdrawals(id,user_id,amount_inr,upi_id,status,created_at) VALUES(?,?,?,?,?,?)`,
      [w.id, w.userId, w.amountInr, w.upiId, w.status, w.createdAt],
    );
    return w;
  }

  async getWithdrawal(id) {
    const [rows] = await this.pool.execute('SELECT * FROM withdrawals WHERE id=?', [id]);
    return mapWithdrawal(rows[0]);
  }

  async updateWithdrawal(id, patch) {
    const cols = { status: 'status', reviewedAt: 'reviewed_at', reviewedBy: 'reviewed_by', paymentRef: 'payment_ref', note: 'note' };
    const sets = [];
    const vals = [];
    for (const [key, col] of Object.entries(cols)) {
      if (patch[key] === undefined) continue;
      sets.push(`${col}=?`);
      vals.push(patch[key]);
    }
    if (!sets.length) return this.getWithdrawal(id);
    vals.push(id);
    await this.pool.execute(`UPDATE withdrawals SET ${sets.join(', ')} WHERE id=?`, vals);
    return this.getWithdrawal(id);
  }

  async listWithdrawals({ status = null, userId = null, limit = 100 } = {}) {
    const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 100));
    const where = [];
    const params = [];
    if (status) { where.push('w.status=?'); params.push(status); }
    if (userId) { where.push('w.user_id=?'); params.push(userId); }
    const [rows] = await this.pool.query(
      `SELECT w.*, u.name AS user_name FROM withdrawals w
       LEFT JOIN users u ON u.id = w.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY w.created_at ASC LIMIT ${lim}`,
      params,
    );
    return rows.map(mapWithdrawal);
  }

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

  // ── coin shop orders ──
  async createCoinOrder(o) {
    await this.pool.execute(
      `INSERT INTO coin_orders(id,user_id,pack_id,coins,amount_inr,pay_payment_id,checkout_url,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [o.id, o.userId, o.packId, o.coins, o.amountInr, o.payPaymentId || null, o.checkoutUrl || null, o.status, o.createdAt, o.updatedAt],
    );
    return this.getCoinOrder(o.id);
  }

  async getCoinOrder(id) {
    const [rows] = await this.pool.execute('SELECT * FROM coin_orders WHERE id=?', [id]);
    return mapCoinOrder(rows[0]);
  }

  async updateCoinOrder(id, patch) {
    const cols = { payPaymentId: 'pay_payment_id', checkoutUrl: 'checkout_url', status: 'status' };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(cols)) {
      if (k in patch) { sets.push(`${col}=?`); params.push(patch[k]); }
    }
    sets.push('updated_at=?');
    params.push(Date.now(), id);
    await this.pool.execute(`UPDATE coin_orders SET ${sets.join(',')} WHERE id=?`, params);
    return this.getCoinOrder(id);
  }

  async listCoinOrders({ status = null, userId = null, since = null, until = null, limit = 50 } = {}) {
    const lim = Math.max(1, Math.min(10000, parseInt(limit, 10) || 50));
    const where = [];
    const params = [];
    if (status) { where.push('status=?'); params.push(status); }
    if (userId) { where.push('user_id=?'); params.push(userId); }
    if (since) { where.push('created_at>=?'); params.push(since); }
    if (until) { where.push('created_at<?'); params.push(until); }
    const [rows] = await this.pool.query(
      `SELECT * FROM coin_orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT ${lim}`,
      params,
    );
    return rows.map(mapCoinOrder);
  }
}

function mapCoinOrder(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    packId: r.pack_id,
    coins: Number(r.coins),
    amountInr: Number(r.amount_inr),
    payPaymentId: r.pay_payment_id,
    checkoutUrl: r.checkout_url,
    status: r.status,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
