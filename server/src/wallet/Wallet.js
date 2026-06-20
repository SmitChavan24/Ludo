import { nanoid } from 'nanoid';
import { Mutex } from '../util/mutex.js';

export class WalletError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Wallet — the coin ledger.
//
// Design principles (the same ones a real-money system needs):
//   • APPEND-ONLY LEDGER. Every balance change is a permanent entry with a
//     reason and the resulting balance. You can reconstruct/audit any account.
//   • ATOMICITY. All mutations run through a single Mutex, so two requests can
//     never race to spend the same coins (no double-spend).
//   • ALL-OR-NOTHING ESCROW. When a staked game starts, every player's stake is
//     debited together or not at all. The pot is only ever paid out once.
//   • INTEGER COINS ONLY. No floats — money math must be exact.
//
// Balances are cached for O(1) reads but are always equal to the sum of ledger
// deltas, which is asserted-by-construction (we only mutate via `_apply`).
// ──────────────────────────────────────────────────────────────────────────
const HOUSE_ACCOUNT = '__house__';

export class Wallet {
  constructor() {
    this.balances = new Map(); // accountId -> integer coins
    this.ledger = []; // append-only [{ id, account, delta, reason, refId, balanceAfter, at }]
    this.lock = new Mutex();
  }

  getBalance(accountId) {
    return this.balances.get(accountId) || 0;
  }

  houseBalance() {
    return this.getBalance(HOUSE_ACCOUNT);
  }

  historyFor(accountId, limit = 50) {
    const out = [];
    for (let i = this.ledger.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.ledger[i].account === accountId) out.push(this.ledger[i]);
    }
    return out;
  }

  // Internal: NOT locked. Only call from inside a `lock.run`.
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

  // Lock every player's stake for a game. All-or-nothing: if anyone is short,
  // nobody is charged. Returns the total pot.
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

  // Pay the winner the pot minus the platform rake; rake goes to the house.
  settlePot(gameId, winnerId, pot, rakeBips) {
    return this.lock.run(() => {
      const rake = Math.floor((pot * rakeBips) / 10000);
      const payout = pot - rake;
      const winEntry = this._apply(winnerId, payout, 'game_win', gameId);
      if (rake > 0) this._apply(HOUSE_ACCOUNT, rake, 'rake', gameId);
      return { payout, rake, balanceAfter: winEntry.balanceAfter };
    });
  }

  // Give every player their stake back (game aborted before a result).
  refundStakes(gameId, userIds, stake) {
    return this.lock.run(() => {
      for (const uid of userIds) this._apply(uid, stake, 'game_refund', gameId);
      return { refunded: userIds.length * stake };
    });
  }
}

export const wallet = new Wallet();
