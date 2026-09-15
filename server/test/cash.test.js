import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CashService, isValidUpiId } from '../src/cash/CashService.js';
import { store } from '../src/db/store.js';
import { wallet } from '../src/wallet/Wallet.js';
import { cashAccount, winningsAccount } from '../src/wallet/accounts.js';
import { config } from '../src/config.js';

const cash = new CashService();
let n = 0;
const mkUser = async (tag) => store.createUser({ provider: 'dev', providerId: `cash-${tag}-${n++}`, name: tag });
// Give a player real money the only legitimate way: an approved deposit.
const fund = async (user, amount) => {
  const c = await cash.requestDeposit(user, { utr: `9${String(n++).padStart(11, '0')}`, amountInr: amount });
  await cash.approveDeposit(c.id, {});
};
// The only legitimate source of withdrawable money: winning a prize.
const win = async (user, amount) => cash.creditWinnings(user.id, amount, 'tournament_prize');

test('UPI ids are validated', () => {
  assert.equal(isValidUpiId('smit@okaxis'), true);
  assert.equal(isValidUpiId('some.name-1@ybl'), true);
  assert.equal(isValidUpiId('9876543210'), false, 'a phone number is not a UPI id');
  assert.equal(isValidUpiId('no-at-sign'), false);
  assert.equal(isValidUpiId(''), false);
});

test('cash and practice coins are completely separate balances', async () => {
  const u = await mkUser('separate');
  await wallet.credit(u.id, 5000, 'signup_bonus'); // practice coins

  assert.equal(await wallet.getBalance(u.id), 5000, 'practice coins');
  assert.equal(await cash.balance(u.id), 0, 'free coins must NOT create cash');

  await fund(u, 200);
  assert.equal(await cash.balance(u.id), 200);
  assert.equal(await wallet.getBalance(u.id), 5000, 'depositing cash must not change coins');
});

test('a deposit grants nothing until an admin approves it', async () => {
  const u = await mkUser('deposit');
  const claim = await cash.requestDeposit(u, { utr: '111122223333', amountInr: 500 });
  assert.equal(claim.status, 'pending');
  assert.equal(claim.purpose, 'deposit');
  assert.equal(await cash.balance(u.id), 0, 'no money until reviewed');

  const res = await cash.approveDeposit(claim.id, { reviewedBy: 'admin' });
  assert.equal(res.credited, 500);
  assert.equal(await cash.balance(u.id), 500);
});

test('the admin can correct the amount at approval time', async () => {
  const u = await mkUser('wrongamount');
  // Player claims ₹500 but actually sent ₹300.
  const claim = await cash.requestDeposit(u, { utr: '222233334444', amountInr: 500 });
  const res = await cash.approveDeposit(claim.id, { amountInr: 300 });
  assert.equal(res.credited, 300, 'credits what the admin verified, not what was claimed');
  assert.equal(await cash.balance(u.id), 300);
});

test('a deposit UTR can never be reused', async () => {
  const a = await mkUser('dup-a');
  const b = await mkUser('dup-b');
  await cash.requestDeposit(a, { utr: '333344445555', amountInr: 100 });
  await assert.rejects(() => cash.requestDeposit(b, { utr: '333344445555', amountInr: 100 }), (e) => e.code === 'DUPLICATE_UTR');
  // Even disguised with spacing.
  await assert.rejects(() => cash.requestDeposit(b, { utr: '3333 4444 5555', amountInr: 100 }), (e) => e.code === 'DUPLICATE_UTR');
});

test('deposits are validated before they reach the queue', async () => {
  const u = await mkUser('badreq');
  await assert.rejects(() => cash.requestDeposit(u, { utr: '444455556666', amountInr: 1 }), (e) => e.code === 'BAD_AMOUNT');
  await assert.rejects(() => cash.requestDeposit(u, { utr: 'junk', amountInr: 500 }), (e) => e.code === 'BAD_UTR');
  // Only one pending deposit at a time.
  await cash.requestDeposit(u, { utr: '555566667777', amountInr: 500 });
  await assert.rejects(() => cash.requestDeposit(u, { utr: '666677778888', amountInr: 500 }), (e) => e.code === 'CLAIM_PENDING');
});

test('a rejected deposit credits nothing', async () => {
  const u = await mkUser('rejected');
  const claim = await cash.requestDeposit(u, { utr: '777788889999', amountInr: 400 });
  await cash.rejectDeposit(claim.id, { reason: 'No payment found' });
  assert.equal(await cash.balance(u.id), 0);
  await assert.rejects(() => cash.approveDeposit(claim.id, {}), (e) => e.code === 'ALREADY_REVIEWED');
});

test('requesting a withdrawal HOLDS the money immediately', async () => {
  const u = await mkUser('holder');
  await win(u, 1000);

  const w = await cash.requestWithdrawal(u, { amountInr: 400, upiId: 'me@okaxis' });
  assert.equal(w.status, 'pending');
  assert.equal(await cash.balance(u.id), 600, 'held straight away, not at payout');

  // The held rupees cannot be requested again.
  await assert.rejects(() => cash.requestWithdrawal(u, { amountInr: 700, upiId: 'me@okaxis' }),
    (e) => e.code === 'WITHDRAWAL_PENDING');
});

test('you cannot withdraw more than you have won', async () => {
  const u = await mkUser('greedy');
  await win(u, 200);
  await assert.rejects(() => cash.requestWithdrawal(u, { amountInr: 500, upiId: 'me@okaxis' }),
    (e) => e.code === 'INSUFFICIENT_FUNDS');
  assert.equal(await cash.balance(u.id), 200, 'balance untouched by a failed request');
});

test('a DEPOSIT alone cannot be withdrawn — only winnings can', async () => {
  const u = await mkUser('depositor');
  await fund(u, 1000);
  const b = await cash.balances(u.id);
  assert.equal(b.deposit, 1000);
  assert.equal(b.winnings, 0);
  assert.equal(b.withdrawable, 0, 'nothing withdrawable until they win');

  await assert.rejects(() => cash.requestWithdrawal(u, { amountInr: 500, upiId: 'me@okaxis' }),
    (e) => e.code === 'NO_WINNINGS');
  // The deposit is NOT confiscated — it stays available to play with.
  assert.equal((await cash.balances(u.id)).total, 1000);
});

test('winning unlocks withdrawal', async () => {
  const u = await mkUser('winner');
  await fund(u, 200);
  await win(u, 500);
  const b = await cash.balances(u.id);
  assert.equal(b.total, 700);
  assert.equal(b.withdrawable, 500, 'only the prize is withdrawable');

  await cash.requestWithdrawal(u, { amountInr: 500, upiId: 'me@okaxis' });
  const after = await cash.balances(u.id);
  assert.equal(after.winnings, 0);
  assert.equal(after.deposit, 200, 'the deposit is untouched by a withdrawal');
});

test('entry fees spend the deposit first, protecting withdrawable winnings', async () => {
  const u = await mkUser('spender');
  await fund(u, 100);
  await win(u, 400);

  await cash.payEntryFee(u.id, 150); // 100 from deposit, 50 from winnings
  const b = await cash.balances(u.id);
  assert.equal(b.deposit, 0);
  assert.equal(b.winnings, 350, 'winnings are only touched once deposits run out');
});

test('practice coins can never be withdrawn', async () => {
  const u = await mkUser('coinsonly');
  await wallet.credit(u.id, 100000, 'signup_bonus'); // a fortune in fake coins
  await assert.rejects(() => cash.requestWithdrawal(u, { amountInr: 500, upiId: 'me@okaxis' }),
    (e) => e.code === 'NO_WINNINGS');
});

test('withdrawal limits are enforced', async () => {
  const u = await mkUser('limits');
  await win(u, 20000);
  await assert.rejects(() => cash.requestWithdrawal(u, { amountInr: 10, upiId: 'me@okaxis' }), (e) => e.code === 'BAD_AMOUNT');
  await assert.rejects(() => cash.requestWithdrawal(u, { amountInr: config.cash.maxWithdrawalInr + 1, upiId: 'me@okaxis' }),
    (e) => e.code === 'BAD_AMOUNT');
  await assert.rejects(() => cash.requestWithdrawal(u, { amountInr: 500, upiId: '9876543210' }), (e) => e.code === 'BAD_UPI');
});

test('marking a withdrawal paid does not deduct twice', async () => {
  const u = await mkUser('paid');
  await win(u, 1000);
  const w = await cash.requestWithdrawal(u, { amountInr: 300, upiId: 'me@okaxis' });
  assert.equal(await cash.balance(u.id), 700);

  await cash.markWithdrawalPaid(w.id, { paymentRef: 'UTR-PAYOUT-1' });
  assert.equal(await cash.balance(u.id), 700, 'already deducted at request time');
  const after = await store.getWithdrawal(w.id);
  assert.equal(after.status, 'paid');
  assert.equal(after.paymentRef, 'UTR-PAYOUT-1');

  await assert.rejects(() => cash.markWithdrawalPaid(w.id, {}), (e) => e.code === 'ALREADY_REVIEWED');
});

test('rejecting a withdrawal returns the held money', async () => {
  const u = await mkUser('refunded');
  await win(u, 1000);
  const w = await cash.requestWithdrawal(u, { amountInr: 600, upiId: 'me@okaxis' });
  assert.equal(await cash.balance(u.id), 400);

  await cash.rejectWithdrawal(w.id, { reason: 'UPI id did not match your name' });
  assert.equal(await cash.balance(u.id), 1000, 'money returned in full');
  assert.equal((await store.getWithdrawal(w.id)).status, 'rejected');
});

test('the ledger accounts for every rupee across both pots', async () => {
  const u = await mkUser('ledger');
  await fund(u, 1000);
  await win(u, 400);
  const w = await cash.requestWithdrawal(u, { amountInr: 250, upiId: 'me@okaxis' });
  await cash.markWithdrawalPaid(w.id, {});

  const deposits = await wallet.historyFor(cashAccount(u.id), 50);
  const winnings = await wallet.historyFor(winningsAccount(u.id), 50);
  const sum = [...deposits, ...winnings].reduce((a, e) => a + e.delta, 0);
  assert.equal(sum, (await cash.balances(u.id)).total, 'ledger sums to the total balance');
  assert.deepEqual(deposits.map((h) => h.reason), ['deposit']);
  assert.deepEqual(winnings.map((h) => h.reason).sort(), ['tournament_prize', 'withdrawal_hold']);
});

// ── Tournament entry paid from the cash wallet ──
import { TournamentService } from '../src/tournament/TournamentService.js';
import './helpers/wideConfig.js';

const tsvc = new TournamentService();

test('a cash tournament charges the admin-set fee from the balance', async () => {
  const t = await tsvc.create({
    title: 'Balance Cup', entryType: 'balance', entryFeeInr: 100,
    rakeBips: 1000, payoutSplit: [70, 30], maxPlayers: 4,
  });
  const u = await mkUser('bal-join');
  await fund(u, 500);

  await tsvc.joinWithBalance(u, t.id);
  assert.equal(await cash.balance(u.id), 400, 'the ₹100 fee you set was debited');

  // Withdrawing before the start returns it.
  await tsvc.removeEntry(t.id, u.id);
  assert.equal(await cash.balance(u.id), 500);
});

test('you cannot join a cash tournament without the balance', async () => {
  const t = await tsvc.create({ title: 'Pricey', entryType: 'balance', entryFeeInr: 500, maxPlayers: 4 });
  const u = await mkUser('bal-poor');
  await fund(u, 100);
  await assert.rejects(() => tsvc.joinWithBalance(u, t.id), (e) => e.code === 'INSUFFICIENT_FUNDS');
  assert.equal(await cash.balance(u.id), 100, 'nothing taken on a failed join');
});

test('a cash tournament pays prizes straight into withdrawable balances', async () => {
  const t = await tsvc.create({
    title: 'Payout Cup', entryType: 'balance', entryFeeInr: 100,
    rakeBips: 1000, payoutSplit: [70, 30], maxPlayers: 4,
  });
  const players = [];
  for (const tag of ['p1', 'p2', 'p3', 'p4']) {
    const u = await mkUser(`pay-${tag}`);
    await fund(u, 300);
    await tsvc.joinWithBalance(u, t.id);
    players.push(u);
  }
  // 4 × ₹100 = ₹400 collected, 10% cut = ₹40, prize pool ₹360 → 252 / 108
  const detail = await tsvc.start(t.id);
  assert.equal(detail.money.collectedInr, 400);
  assert.equal(detail.money.yourCutInr, 40);
  assert.deepEqual(detail.money.payouts.map((p) => p.amountInr), [252, 108]);

  for (const m of detail.playing) await tsvc.recordResult(t.id, m.id, m.a);
  const finalMatch = (await tsvc.detail(t.id)).playing[0];
  const champ = finalMatch.a;
  const runnerUp = finalMatch.b;
  await tsvc.recordResult(t.id, finalMatch.id, champ);

  // Everyone paid ₹100 from ₹300, so each starts the settlement at ₹200.
  assert.equal(await cash.balance(champ), 200 + 252, 'winner paid automatically');
  assert.equal(await cash.balance(runnerUp), 200 + 108, 'runner-up paid automatically');
});
