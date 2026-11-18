import { nanoid } from 'nanoid';
import { WalletError } from './errors.js';

const HOUSE_ACCOUNT = '__house__';

// MySQL-backed coin ledger. Atomicity comes from real DB transactions + row
// locks (`SELECT ... FOR UPDATE`) instead of an in-process mutex, so it stays
// correct even across multiple server instances.
//   • balances(account_id PK, coins BIGINT)   — current balance per account
//   • ledger(... balance_after ...)           — append-only audit trail
export class MysqlWallet {
  constructor(pool) {
    this.pool = pool;
  }

  async getBalance(accountId) {
    const [rows] = await this.pool.execute('SELECT coins FROM balances WHERE account_id=?', [accountId]);
    return rows.length ? Number(rows[0].coins) : 0;
  }

  async houseBalance() {
    return this.getBalance(HOUSE_ACCOUNT);
  }

  async historyFor(accountId, limit = 50) {
    const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    const [rows] = await this.pool.query(
      `SELECT id, account_id, delta, reason, ref_id, balance_after, created_at
       FROM ledger WHERE account_id=? ORDER BY created_at DESC, id DESC LIMIT ${lim}`,
      [accountId],
    );
    return rows.map((r) => ({
      id: r.id,
      account: r.account_id,
      delta: Number(r.delta),
      reason: r.reason,
      refId: r.ref_id,
      balanceAfter: Number(r.balance_after),
      at: Number(r.created_at),
    }));
  }

  _assertPositiveInt(amount) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new WalletError('Amount must be a positive integer', 'BAD_AMOUNT');
    }
  }

  // Run `fn(conn)` inside a transaction, committing on success and rolling back
  // on any error. The connection is always released.
  async _withTxn(fn) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  // Apply a signed delta to a balance and append a ledger row, returning the new
  // balance. Must be called inside a transaction.
  async _applyTxn(conn, account, delta, reason, refId) {
    await conn.execute(
      'INSERT INTO balances(account_id, coins) VALUES(?, ?) ON DUPLICATE KEY UPDATE coins = coins + ?',
      [account, delta, delta],
    );
    const [rows] = await conn.execute('SELECT coins FROM balances WHERE account_id=?', [account]);
    const balanceAfter = Number(rows[0].coins);
    await conn.execute(
      `INSERT INTO ledger(id, account_id, delta, reason, ref_id, balance_after, created_at)
       VALUES(?,?,?,?,?,?,?)`,
      [nanoid(16), account, delta, reason, refId || null, balanceAfter, Date.now()],
    );
    return balanceAfter;
  }

  // Lock the account row and throw if it can't cover `amount`.
  async _ensureFunds(conn, account, amount) {
    const [rows] = await conn.execute('SELECT coins FROM balances WHERE account_id=? FOR UPDATE', [account]);
    const current = rows.length ? Number(rows[0].coins) : 0;
    if (current < amount) throw new WalletError('Insufficient coins', 'INSUFFICIENT_FUNDS');
  }

  async credit(accountId, amount, reason, refId) {
    this._assertPositiveInt(amount);
    const balanceAfter = await this._withTxn((c) => this._applyTxn(c, accountId, amount, reason, refId));
    return { balanceAfter };
  }

  // Credit exactly once per `key`. The key row is inserted in the SAME
  // transaction as the credit, so either both happen or neither does; a second
  // attempt hits the primary key and credits nothing. Returns null if applied.
  async creditOnce(key, accountId, amount, reason, refId) {
    this._assertPositiveInt(amount);
    try {
      return await this._withTxn(async (c) => {
        await c.execute('INSERT INTO wallet_once(once_key, created_at) VALUES(?, ?)', [key, Date.now()]);
        return { balanceAfter: await this._applyTxn(c, accountId, amount, reason, refId) };
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return null;
      throw err;
    }
  }

  async debit(accountId, amount, reason, refId) {
    this._assertPositiveInt(amount);
    const balanceAfter = await this._withTxn(async (c) => {
      await this._ensureFunds(c, accountId, amount);
      return this._applyTxn(c, accountId, -amount, reason, refId);
    });
    return { balanceAfter };
  }

  async escrowStakes(gameId, userIds, stake) {
    this._assertPositiveInt(stake);
    return this._withTxn(async (c) => {
      // Lock rows in a stable order to avoid deadlocks between concurrent games.
      const ordered = [...userIds].sort();
      for (const uid of ordered) await this._ensureFunds(c, uid, stake);
      for (const uid of userIds) await this._applyTxn(c, uid, -stake, 'game_stake', gameId);
      return { pot: stake * userIds.length };
    });
  }

  async settlePot(gameId, winnerId, pot, rakeBips) {
    return this._withTxn(async (c) => {
      const rake = Math.floor((pot * rakeBips) / 10000);
      const payout = pot - rake;
      const balanceAfter = await this._applyTxn(c, winnerId, payout, 'game_win', gameId);
      if (rake > 0) await this._applyTxn(c, HOUSE_ACCOUNT, rake, 'rake', gameId);
      return { payout, rake, balanceAfter };
    });
  }

  async refundStakes(gameId, userIds, stake) {
    return this._withTxn(async (c) => {
      for (const uid of userIds) await this._applyTxn(c, uid, stake, 'game_refund', gameId);
      return { refunded: userIds.length * stake };
    });
  }

  // ── accounting reports (read-only) ──
  // Account kinds: '__house__' = the house; 'cash:'/'winnings:' = real-money
  // accounts (unused while cash is off); anything else is a player's coins.

  _range(since, until) {
    const where = [];
    const params = [];
    if (since) { where.push('created_at >= ?'); params.push(since); }
    if (until) { where.push('created_at < ?'); params.push(until); }
    return { where, params };
  }

  // Totals per reason and account kind within a time range.
  async ledgerSummary({ since = null, until = null } = {}) {
    const { where, params } = this._range(since, until);
    const [rows] = await this.pool.query(
      `SELECT reason,
              CASE WHEN account_id = '${HOUSE_ACCOUNT}' THEN 'house'
                   WHEN account_id LIKE 'cash:%' OR account_id LIKE 'winnings:%' THEN 'cash'
                   ELSE 'player' END AS kind,
              COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS credits,
              COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS debits
       FROM ledger ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY reason, kind`,
      params,
    );
    return rows.map((r) => ({ reason: r.reason, kind: r.kind, count: Number(r.n), credits: Number(r.credits), debits: Number(r.debits) }));
  }

  // Same, per calendar day in India time (UTC+5:30).
  async ledgerDaily({ since = null, until = null } = {}) {
    const { where, params } = this._range(since, until);
    const [rows] = await this.pool.query(
      `SELECT DATE_ADD('1970-01-01', INTERVAL FLOOR((created_at + 19800000) / 86400000) DAY) AS day,
              reason,
              CASE WHEN account_id = '${HOUSE_ACCOUNT}' THEN 'house'
                   WHEN account_id LIKE 'cash:%' OR account_id LIKE 'winnings:%' THEN 'cash'
                   ELSE 'player' END AS kind,
              COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS credits,
              COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS debits
       FROM ledger ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY day, reason, kind ORDER BY day DESC`,
      params,
    );
    return rows.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
      reason: r.reason, kind: r.kind, credits: Number(r.credits), debits: Number(r.debits),
    }));
  }

  // Raw ledger lines, newest first, with optional filters.
  async listLedger({ accountId = null, reason = null, since = null, until = null, limit = 100, offset = 0 } = {}) {
    const { where, params } = this._range(since, until);
    if (accountId) { where.push('account_id = ?'); params.push(accountId); }
    if (reason) { where.push('reason = ?'); params.push(reason); }
    const lim = Math.max(1, Math.min(5000, parseInt(limit, 10) || 100));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await this.pool.query(
      `SELECT id, account_id, delta, reason, ref_id, balance_after, created_at FROM ledger ${clause}
       ORDER BY created_at DESC, id DESC LIMIT ${lim} OFFSET ${off}`,
      params,
    );
    const [[{ total }]] = await this.pool.query(`SELECT COUNT(*) AS total FROM ledger ${clause}`, params);
    return {
      total: Number(total),
      rows: rows.map((r) => ({
        id: r.id, account: r.account_id, delta: Number(r.delta), reason: r.reason,
        refId: r.ref_id, balanceAfter: Number(r.balance_after), at: Number(r.created_at),
      })),
    };
  }

  // Current coins held by players and by the house, right now.
  async balanceTotals() {
    const [[row]] = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN account_id <> '${HOUSE_ACCOUNT}' AND account_id NOT LIKE 'cash:%' AND account_id NOT LIKE 'winnings:%' THEN coins ELSE 0 END), 0) AS players,
         COALESCE(SUM(CASE WHEN account_id = '${HOUSE_ACCOUNT}' THEN coins ELSE 0 END), 0) AS house,
         SUM(CASE WHEN account_id <> '${HOUSE_ACCOUNT}' AND account_id NOT LIKE 'cash:%' AND account_id NOT LIKE 'winnings:%' AND coins > 0 THEN 1 ELSE 0 END) AS holders
       FROM balances`,
    );
    return { players: Number(row.players), house: Number(row.house), holders: Number(row.holders || 0) };
  }
}
