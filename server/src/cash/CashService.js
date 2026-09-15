import { nanoid } from 'nanoid';
import { store } from '../db/store.js';
import { wallet } from '../wallet/Wallet.js';
import { cashAccount, winningsAccount } from '../wallet/accounts.js';
import { config } from '../config.js';
import { normalizeUtr, isValidUtr } from '../util/payments.js';
import { push } from '../push/PushService.js';

export class CashError extends Error {
  constructor(message, code = 'CASH_ERROR') {
    super(message);
    this.name = 'CashError';
    this.code = code;
  }
}

// A UPI id looks like name@bank. Loose on purpose — handles are varied — but
// tight enough to catch a phone number or a typo'd blank.
const UPI_RE = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9.\-_]{1,32}$/;
export const isValidUpiId = (v) => UPI_RE.test(String(v || '').trim());

// ──────────────────────────────────────────────────────────────────────────
// CashService — real money in and out.
//
// Money can ONLY enter when an admin approves a payment they have seen in their
// own bank account, and can only leave through an approved withdrawal. Nothing
// here ever credits cash automatically.
//
// Cash lives in its own ledger account (`cash:<userId>`), completely separate
// from practice coins, so the two can never be confused or converted.
// ──────────────────────────────────────────────────────────────────────────
export class CashService {
  // Deposits and winnings are tracked separately; `total` is what the player
  // can play with, `winnings` is what they can actually take out.
  async balances(userId) {
    const [deposit, winnings] = await Promise.all([
      wallet.getBalance(cashAccount(userId)),
      wallet.getBalance(winningsAccount(userId)),
    ]);
    return { deposit, winnings, total: deposit + winnings, withdrawable: winnings };
  }

  // Total playable balance (kept for callers that just need one number).
  async balance(userId) {
    const b = await this.balances(userId);
    return b.total;
  }

  async history(userId, limit = 50) {
    const [d, w] = await Promise.all([
      wallet.historyFor(cashAccount(userId), limit),
      wallet.historyFor(winningsAccount(userId), limit),
    ]);
    return [...d, ...w].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  // Prizes always land in the withdrawable pot.
  async creditWinnings(userId, amountInr, reason = 'tournament_prize', refId = null) {
    return wallet.credit(winningsAccount(userId), amountInr, reason, refId);
  }

  // Entry fees spend the DEPOSIT balance first and only then dip into winnings,
  // so a player's withdrawable money is the last thing to be consumed.
  async payEntryFee(userId, amountInr, refId = null) {
    const { deposit, winnings } = await this.balances(userId);
    if (deposit + winnings < amountInr) {
      throw new CashError('Not enough balance — add money first', 'INSUFFICIENT_FUNDS');
    }
    const fromDeposit = Math.min(deposit, amountInr);
    const fromWinnings = amountInr - fromDeposit;
    if (fromDeposit > 0) await wallet.debit(cashAccount(userId), fromDeposit, 'tournament_entry', refId);
    if (fromWinnings > 0) await wallet.debit(winningsAccount(userId), fromWinnings, 'tournament_entry', refId);
    return { fromDeposit, fromWinnings };
  }

  // Refund an entry back the way it came.
  async refundEntryFee(userId, amountInr, refId = null) {
    return wallet.credit(cashAccount(userId), amountInr, 'tournament_refund', refId);
  }

  // ── deposits ──

  // The player says "I sent you ₹X, here's the reference". This grants nothing;
  // it just joins your review queue.
  async requestDeposit(user, { utr, amountInr, note = '' } = {}) {
    const amount = Math.trunc(Number(amountInr));
    if (!Number.isInteger(amount) || amount < config.cash.minDepositInr) {
      throw new CashError(`Minimum deposit is ₹${config.cash.minDepositInr}`, 'BAD_AMOUNT');
    }
    const clean = normalizeUtr(utr);
    if (!isValidUtr(clean)) {
      throw new CashError('Enter the 12-digit UPI reference (UTR) from your payment', 'BAD_UTR');
    }
    const pending = await store.getActiveDepositClaim(user.id);
    if (pending) throw new CashError('You already have a deposit awaiting review', 'CLAIM_PENDING');

    const claim = {
      id: nanoid(16),
      tournamentId: null,
      purpose: 'deposit',
      userId: user.id,
      utr: clean,
      amountInr: amount,
      note: String(note || '').slice(0, 255),
      status: 'pending',
      createdAt: Date.now(),
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
    };
    const created = await store.createClaim(claim);
    if (!created) {
      // The UTR is already attached to another claim — the same payment cannot
      // be counted twice.
      throw new CashError('That transaction reference has already been submitted', 'DUPLICATE_UTR');
    }
    return created;
  }

  // Admin confirmed the money arrived → credit the player's cash balance.
  // The credited amount is whatever the ADMIN verifies, not what the player
  // claimed, so a wrong claim can be corrected at approval time.
  async approveDeposit(claimId, { reviewedBy = 'admin', amountInr = null, note = '' } = {}) {
    const claim = await store.getClaim(claimId);
    if (!claim) throw new CashError('Deposit not found', 'NOT_FOUND');
    if (claim.purpose !== 'deposit') throw new CashError('Not a deposit claim', 'WRONG_PURPOSE');
    if (claim.status !== 'pending') throw new CashError(`Already ${claim.status}`, 'ALREADY_REVIEWED');

    const amount = amountInr == null ? claim.amountInr : Math.trunc(Number(amountInr));
    if (!Number.isInteger(amount) || amount <= 0) throw new CashError('Invalid amount', 'BAD_AMOUNT');

    await wallet.credit(cashAccount(claim.userId), amount, 'deposit', claim.utr);
    await store.updateClaim(claimId, {
      status: 'approved',
      reviewedAt: Date.now(),
      reviewedBy,
      reviewNote: String(note || '').slice(0, 255),
    });
    push
      .sendToUser(claim.userId, {
        title: 'Deposit confirmed ✅',
        body: `₹${amount} added to your balance.`,
        tag: 'deposit',
        url: '/',
      })
      .catch(() => {});
    return { claim: await store.getClaim(claimId), credited: amount, balance: await this.balance(claim.userId) };
  }

  async rejectDeposit(claimId, { reviewedBy = 'admin', reason = '' } = {}) {
    const claim = await store.getClaim(claimId);
    if (!claim) throw new CashError('Deposit not found', 'NOT_FOUND');
    if (claim.status !== 'pending') throw new CashError(`Already ${claim.status}`, 'ALREADY_REVIEWED');
    push
      .sendToUser(claim.userId, {
        title: 'Deposit could not be confirmed',
        body: reason || 'We could not find that payment. Please check the reference.',
        tag: 'deposit',
        url: '/',
      })
      .catch(() => {});
    return store.updateClaim(claimId, {
      status: 'rejected',
      reviewedAt: Date.now(),
      reviewedBy,
      reviewNote: String(reason || '').slice(0, 255),
    });
  }

  // ── withdrawals ──

  // Requesting HOLDS the money immediately (debits it). Without that a player
  // could request the same rupees several times, or spend them while a request
  // sits in the queue.
  async requestWithdrawal(user, { amountInr, upiId } = {}) {
    const amount = Math.trunc(Number(amountInr));
    if (!Number.isInteger(amount) || amount < config.cash.minWithdrawalInr) {
      throw new CashError(`Minimum withdrawal is ₹${config.cash.minWithdrawalInr}`, 'BAD_AMOUNT');
    }
    if (amount > config.cash.maxWithdrawalInr) {
      throw new CashError(`Maximum withdrawal is ₹${config.cash.maxWithdrawalInr} per request`, 'BAD_AMOUNT');
    }
    if (!isValidUpiId(upiId)) throw new CashError('Enter a valid UPI ID (e.g. name@bank)', 'BAD_UPI');

    const pending = await store.listWithdrawals({ status: 'pending', userId: user.id, limit: 1 });
    if (pending.length) throw new CashError('You already have a withdrawal awaiting payout', 'WITHDRAWAL_PENDING');

    // Only prize money can leave. A player who has never won has nothing to
    // withdraw — their deposit stays available to keep playing with.
    const { winnings } = await this.balances(user.id);
    if (winnings <= 0) {
      throw new CashError('Only tournament winnings can be withdrawn — win a tournament first', 'NO_WINNINGS');
    }
    if (amount > winnings) {
      throw new CashError(`You can withdraw up to ₹${winnings} (your winnings)`, 'INSUFFICIENT_FUNDS');
    }

    // debit() throws INSUFFICIENT_FUNDS if the balance can't cover it, and the
    // wallet serialises mutations, so two simultaneous requests can't both pass.
    try {
      await wallet.debit(winningsAccount(user.id), amount, 'withdrawal_hold');
    } catch (e) {
      if (e.code === 'INSUFFICIENT_FUNDS') throw new CashError('Not enough balance', 'INSUFFICIENT_FUNDS');
      throw e;
    }

    return store.createWithdrawal({
      id: nanoid(16),
      userId: user.id,
      amountInr: amount,
      upiId: String(upiId).trim(),
      status: 'pending',
      createdAt: Date.now(),
    });
  }

  // You have sent the money by UPI → close the request. The balance was already
  // reduced when it was requested, so nothing further is deducted here.
  async markWithdrawalPaid(id, { reviewedBy = 'admin', paymentRef = '', note = '' } = {}) {
    const w = await store.getWithdrawal(id);
    if (!w) throw new CashError('Withdrawal not found', 'NOT_FOUND');
    if (w.status !== 'pending') throw new CashError(`Already ${w.status}`, 'ALREADY_REVIEWED');

    await store.updateWithdrawal(id, {
      status: 'paid',
      reviewedAt: Date.now(),
      reviewedBy,
      paymentRef: String(paymentRef || '').slice(0, 128),
      note: String(note || '').slice(0, 255),
    });
    push
      .sendToUser(w.userId, {
        title: '💸 Withdrawal sent',
        body: `₹${w.amountInr} has been sent to ${w.upiId}.`,
        tag: 'withdrawal',
        url: '/',
      })
      .catch(() => {});
    return store.getWithdrawal(id);
  }

  // Refuse the payout and RETURN the held money.
  async rejectWithdrawal(id, { reviewedBy = 'admin', reason = '' } = {}) {
    const w = await store.getWithdrawal(id);
    if (!w) throw new CashError('Withdrawal not found', 'NOT_FOUND');
    if (w.status !== 'pending') throw new CashError(`Already ${w.status}`, 'ALREADY_REVIEWED');

    await wallet.credit(winningsAccount(w.userId), w.amountInr, 'withdrawal_refund', id);
    await store.updateWithdrawal(id, {
      status: 'rejected',
      reviewedAt: Date.now(),
      reviewedBy,
      note: String(reason || '').slice(0, 255),
    });
    push
      .sendToUser(w.userId, {
        title: 'Withdrawal declined',
        body: reason ? `${reason} Your ₹${w.amountInr} has been returned.` : `Your ₹${w.amountInr} has been returned to your balance.`,
        tag: 'withdrawal',
        url: '/',
      })
      .catch(() => {});
    return store.getWithdrawal(id);
  }

  // Total real money you are currently holding on players' behalf — the number
  // that must always be covered by your actual bank balance.
  async totalHeld() {
    return wallet.sumAccounts?.('cash:') ?? null;
  }
}

export const cash = new CashService();
