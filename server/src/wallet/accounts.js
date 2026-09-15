// ──────────────────────────────────────────────────────────────────────────
// Every player has TWO separate balances, and they must never mix:
//
//   PRACTICE COINS  (account id = userId)
//     Free, fake, given away freely (signup, daily bonus, referrals) and used
//     for casual staked games. Can NEVER be withdrawn.
//
//   CASH  (account id = "cash:<userId>", whole rupees)
//     Real money. Enters ONLY when an admin approves a payment, leaves only as
//     a tournament entry fee or an approved withdrawal.
//
// Keeping them as distinct ledger accounts means the append-only ledger already
// tells you, for any moment in time, exactly how much real money you are
// holding on players' behalf — which is the number that actually matters.
// ──────────────────────────────────────────────────────────────────────────

const CASH_PREFIX = 'cash:';
const WIN_PREFIX = 'win:';

// Deposit balance — money the player added. Playable, but NOT withdrawable:
// letting deposits straight back out makes the platform a money-transfer
// service, which is both a laundering risk and not what a game wallet is for.
export const cashAccount = (userId) => `${CASH_PREFIX}${userId}`;

// Winnings — prizes actually won. This is the only balance that can be cashed
// out, so "you can withdraw once you've won" is enforced by the accounts
// themselves rather than by a UI rule someone could bypass.
export const winningsAccount = (userId) => `${WIN_PREFIX}${userId}`;
export const isWinningsAccount = (accountId) => String(accountId).startsWith(WIN_PREFIX);
export const coinAccount = (userId) => String(userId);
export const isCashAccount = (accountId) => String(accountId).startsWith(CASH_PREFIX);
export const userIdFromCashAccount = (accountId) => String(accountId).slice(CASH_PREFIX.length);
