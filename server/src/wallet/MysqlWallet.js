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
}
