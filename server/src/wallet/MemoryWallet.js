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
}
