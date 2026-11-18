import { nanoid } from 'nanoid';
import { Mutex } from '../util/mutex.js';
import { WalletError } from './errors.js';

const HOUSE_ACCOUNT = '__house__';

// In-memory coin ledger (the default backend; also used by the test suite).
// Same guarantees as before: append-only ledger, integer coins, all mutations
// serialized through a Mutex. Reads are async to match the storage interface.
export class MemoryWallet {
  constructor() {
    this.balances = new Map();
    this.ledger = [];
    this.lock = new Mutex();
    this.onceKeys = new Set();
  }

  async getBalance(accountId) {
    return this.balances.get(accountId) || 0;
  }

  async houseBalance() {
    return this.getBalance(HOUSE_ACCOUNT);
  }

  async historyFor(accountId, limit = 50) {
    const out = [];
    for (let i = this.ledger.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.ledger[i].account === accountId) out.push(this.ledger[i]);
    }
    return out;
  }

  _apply(account, delta, reason, refId) {
    const balanceAfter = (this.balances.get(account) || 0) + delta;
    this.balances.set(account, balanceAfter);
    const entry = {
      id: nanoid(16),
      account,
      delta,
      reason,
      refId: refId || null,
      balanceAfter,
      at: Date.now(),
    };
    this.ledger.push(entry);
    return entry;
  }

  _assertPositiveInt(amount) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new WalletError('Amount must be a positive integer', 'BAD_AMOUNT');
    }
  }

  credit(accountId, amount, reason, refId) {
    this._assertPositiveInt(amount);
    return this.lock.run(() => this._apply(accountId, amount, reason, refId));
  }

  // Credit exactly once per `key` (e.g. one paid coin order). Returns null if
  // this key was already applied, so retries and races can never double-credit.
  creditOnce(key, accountId, amount, reason, refId) {
    this._assertPositiveInt(amount);
    return this.lock.run(() => {
      if (this.onceKeys.has(key)) return null;
      this.onceKeys.add(key);
      return this._apply(accountId, amount, reason, refId);
    });
  }

  debit(accountId, amount, reason, refId) {
    this._assertPositiveInt(amount);
    return this.lock.run(() => {
      if ((this.balances.get(accountId) || 0) < amount) {
        throw new WalletError('Insufficient coins', 'INSUFFICIENT_FUNDS');
      }
      return this._apply(accountId, -amount, reason, refId);
    });
  }

  escrowStakes(gameId, userIds, stake) {
    this._assertPositiveInt(stake);
    return this.lock.run(() => {
      for (const uid of userIds) {
        if ((this.balances.get(uid) || 0) < stake) {
          throw new WalletError(`Player ${uid} has insufficient coins`, 'INSUFFICIENT_FUNDS');
        }
      }
      for (const uid of userIds) this._apply(uid, -stake, 'game_stake', gameId);
      return { pot: stake * userIds.length };
    });
  }

  settlePot(gameId, winnerId, pot, rakeBips) {
    return this.lock.run(() => {
      const rake = Math.floor((pot * rakeBips) / 10000);
      const payout = pot - rake;
      const winEntry = this._apply(winnerId, payout, 'game_win', gameId);
      if (rake > 0) this._apply(HOUSE_ACCOUNT, rake, 'rake', gameId);
      return { payout, rake, balanceAfter: winEntry.balanceAfter };
    });
  }

  refundStakes(gameId, userIds, stake) {
    return this.lock.run(() => {
      for (const uid of userIds) this._apply(uid, stake, 'game_refund', gameId);
      return { refunded: userIds.length * stake };
    });
  }

  // ── accounting reports (read-only; same shapes as MysqlWallet) ──
  _kind(account) {
    if (account === HOUSE_ACCOUNT) return 'house';
    if (account.startsWith('cash:') || account.startsWith('winnings:')) return 'cash';
    return 'player';
  }

  _inRange(e, since, until) {
    return (!since || e.at >= since) && (!until || e.at < until);
  }

  async ledgerSummary({ since = null, until = null } = {}) {
    const map = new Map();
    for (const e of this.ledger) {
      if (!this._inRange(e, since, until)) continue;
      const kind = this._kind(e.account);
      const key = `${e.reason}|${kind}`;
      const row = map.get(key) || { reason: e.reason, kind, count: 0, credits: 0, debits: 0 };
      row.count += 1;
      if (e.delta > 0) row.credits += e.delta;
      else row.debits -= e.delta;
      map.set(key, row);
    }
    return [...map.values()];
  }

  async ledgerDaily({ since = null, until = null } = {}) {
    const map = new Map();
    for (const e of this.ledger) {
      if (!this._inRange(e, since, until)) continue;
      const day = new Date(e.at + 19800000).toISOString().slice(0, 10); // India time
      const kind = this._kind(e.account);
      const key = `${day}|${e.reason}|${kind}`;
      const row = map.get(key) || { day, reason: e.reason, kind, credits: 0, debits: 0 };
      if (e.delta > 0) row.credits += e.delta;
      else row.debits -= e.delta;
      map.set(key, row);
    }
    return [...map.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  }

  async listLedger({ accountId = null, reason = null, since = null, until = null, limit = 100, offset = 0 } = {}) {
    const all = this.ledger
      .filter((e) => this._inRange(e, since, until) && (!accountId || e.account === accountId) && (!reason || e.reason === reason))
      .reverse();
    return { total: all.length, rows: all.slice(offset, offset + Math.min(5000, limit)) };
  }

  async balanceTotals() {
    let players = 0;
    let holders = 0;
    for (const [account, coins] of this.balances) {
      if (this._kind(account) !== 'player') continue;
      players += coins;
      if (coins > 0) holders += 1;
    }
    return { players, house: this.balances.get(HOUSE_ACCOUNT) || 0, holders };
  }
}
