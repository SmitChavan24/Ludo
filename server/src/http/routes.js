import { Router } from 'express';
import { nanoid } from 'nanoid';
import { verifyGoogleIdToken } from '../auth/google.js';
import {
  signAccessToken,
  signGuestToken,
  issueRefreshToken,
  verifyRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from '../auth/jwt.js';
import { findOrCreateUser, claimDailyBonus, publicProfile } from '../auth/accountService.js';
import { requireAuth, requireAccount } from '../middleware/auth.js';
import { authLimiter, guestLimiter } from '../middleware/security.js';
import { wallet } from '../wallet/Wallet.js';
import { store } from '../db/store.js';
import { config } from '../config.js';
import { tournaments } from '../tournament/TournamentService.js';
import { upiPayLink } from '../util/payments.js';
import { push } from '../push/PushService.js';
import { cash } from '../cash/CashService.js';
import { cashAccount } from '../wallet/accounts.js';

export const router = Router();

async function issueTokens(user) {
  return {
    accessToken: signAccessToken(user),
    refreshToken: await issueRefreshToken(user),
    expiresIn: config.jwt.accessTtl,
  };
}

router.get('/health', (req, res) => res.json({ ok: true, env: config.env }));

// Public client bootstrap: which stakes / table sizes are open right now, plus
// economy numbers the UI displays. Server-driven so you can widen the lobby
// (or throttle it) without rebuilding the client.
router.get('/config', (req, res) => {
  res.json({
    stakes: config.economy.stakes,
    playerCounts: config.economy.playerCounts,
    rakeBips: config.economy.rakeBips,
    dailyBonus: config.economy.dailyBonus,
    referralBonus: config.economy.referralBonus,
    turnTimeoutMs: config.economy.turnTimeoutMs,
    googleEnabled: !!config.googleClientId,
    pushRequiredForPractice: config.push.enabled && config.push.requireForPractice,
    pushRequiredForTournaments: config.push.enabled && config.push.requireForTournaments,
    practiceEnabled: config.practice.enabled,
    practiceBotWaitMs: config.practice.botWaitMs,
    payments: config.payments,
  });
});

// ── Google Sign-In: browser sends Google's ID token, we verify & issue ours ──
router.post('/auth/google', authLimiter, async (req, res) => {
  try {
    const { idToken, referralCode } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });
    const profile = await verifyGoogleIdToken(idToken);
    const { user, isNew, referral } = await findOrCreateUser('google', profile, referralCode);
    res.json({ ...(await issueTokens(user)), user: await publicProfile(user), isNew, referral });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Google login failed' });
  }
});

// ── Guest session for PRACTICE play only ──
// No account, no name, no coins. The token's `guest` scope is what stops it
// reaching anything that touches the wallet.
router.post('/auth/guest', guestLimiter, (req, res) => {
  if (!config.practice.enabled) {
    return res.status(503).json({ error: 'Practice mode is disabled' });
  }
  const guestId = `guest:${nanoid(16)}`;
  res.json({
    accessToken: signGuestToken(guestId, config.practice.guestTtl),
    expiresIn: config.practice.guestTtl,
    user: { id: guestId, name: 'Player', picture: null, isGuest: true, coins: 0, gamesPlayed: 0, gamesWon: 0 },
  });
});

// ── Dev-only passwordless login for local testing (disabled in production) ──
if (config.allowDevLogin) {
  router.post('/auth/dev', authLimiter, async (req, res) => {
    const rawName = (req.body?.name || 'Guest').toString().slice(0, 24);
    const slug = rawName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'guest';
    const profile = { providerId: `dev-${slug}`, email: null, name: rawName, picture: null };
    const { user, isNew, referral } = await findOrCreateUser('dev', profile, req.body?.referralCode);
    res.json({ ...(await issueTokens(user)), user: await publicProfile(user), isNew, referral });
  });
}

// ── Refresh: rotate the refresh token (one-time use) and mint a new access token ──
router.post('/auth/refresh', authLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });
    const payload = await verifyRefreshToken(refreshToken);
    const user = await store.getUser(payload.sub);
    if (!user) return res.status(401).json({ error: 'Unknown user' });
    const newRefresh = await rotateRefreshToken(payload, user);
    res.json({ accessToken: signAccessToken(user), refreshToken: newRefresh, expiresIn: config.jwt.accessTtl });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

router.post('/auth/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (refreshToken) await revokeRefreshToken(await verifyRefreshToken(refreshToken));
  } catch {
    /* already invalid — nothing to revoke */
  }
  res.json({ ok: true });
});

// ── Authenticated account / wallet ──
router.get('/me', requireAuth, async (req, res) => res.json({ user: await publicProfile(req.user) }));

router.post('/me/daily-bonus', requireAuth, requireAccount, async (req, res) => {
  const result = await claimDailyBonus(req.user.id);
  res.json(result);
});

// Two balances, kept strictly apart: practice coins (free, never withdrawable)
// and cash (real rupees, only from approved deposits).
router.get('/wallet', requireAuth, requireAccount, async (req, res) => {
  res.json({
    coins: await wallet.getBalance(req.user.id),
    cashInr: (await cash.balances(req.user.id)).total,
    balances: await cash.balances(req.user.id), // { deposit, winnings, total, withdrawable }
    coinHistory: await wallet.historyFor(req.user.id, 50),
    cashHistory: await cash.history(req.user.id, 50),
    limits: {
      minDepositInr: config.cash.minDepositInr,
      minWithdrawalInr: config.cash.minWithdrawalInr,
      maxWithdrawalInr: config.cash.maxWithdrawalInr,
    },
    pendingDeposit: await store.getActiveDepositClaim(req.user.id),
    pendingWithdrawal: (await store.listWithdrawals({ status: 'pending', userId: req.user.id, limit: 1 }))[0] || null,
    upi: { id: config.payments.upiId, name: config.payments.upiName, qrUrl: config.payments.upiQrUrl },
  });
});

// ── Deposits (add money) ──
router.post('/wallet/deposit', requireAuth, requireAccount, authLimiter, async (req, res) => {
  try {
    res.json({ ok: true, claim: await cash.requestDeposit(req.user, req.body || {}) });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

// ── Withdrawals (cash out) ──
router.post('/wallet/withdraw', requireAuth, requireAccount, authLimiter, async (req, res) => {
  try {
    const w = await cash.requestWithdrawal(req.user, req.body || {});
    res.json({ ok: true, withdrawal: w, cashInr: await cash.balance(req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

router.get('/wallet/withdrawals', requireAuth, requireAccount, async (req, res) => {
  res.json({ withdrawals: await store.listWithdrawals({ userId: req.user.id, limit: 20 }) });
});

// ── Referrals ──
router.get('/me/referral', requireAuth, requireAccount, async (req, res) => {
  const invited = await store.countReferrals(req.user.id);
  res.json({
    code: req.user.referralCode || null,
    invited,
    bonusPerInvite: config.economy.referralBonus,
    earned: invited * config.economy.referralBonus,
  });
});

// ── Web push ──
// The public VAPID key is safe to expose — it's what the browser needs to
// create a subscription. The private key never leaves the server.
router.get('/push/key', (req, res) => res.json({ publicKey: push.publicKey() }));

// Guests may subscribe too — practice can be gated on notifications, and a
// guest has no account to fall back on.
router.post('/push/subscribe', requireAuth, async (req, res) => {
  try {
    await push.subscribe(req.user.id, req.body?.subscription);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/push/unsubscribe', requireAuth, async (req, res) => {
  await push.unsubscribe(req.body?.endpoint);
  res.json({ ok: true });
});

// ── Tournaments (player-facing) ──
const TOURNAMENT_STATUSES = ['open', 'lobby', 'running', 'finished', 'cancelled'];

router.get('/tournaments', requireAuth, requireAccount, async (req, res) => {
  const asked = req.query.status;
  // No status means "all". An UNRECOGNISED status must return nothing rather
  // than falling back to everything — that silent fallback is what made a
  // filtered request answer with the whole list.
  if (asked != null && asked !== '' && !TOURNAMENT_STATUSES.includes(asked)) {
    return res.json({ tournaments: [] });
  }
  const status = TOURNAMENT_STATUSES.includes(asked) ? asked : null;
  res.json({ tournaments: await tournaments.list({ status, limit: 50 }) });
});

router.get('/tournaments/mine', requireAuth, requireAccount, async (req, res) => {
  res.json({ tournaments: await store.listTournamentsForUser(req.user.id, 20) });
});

// Every tournament this player has entered: where they finished, and why their
// run ended. Registered before /tournaments/:id so "history" isn't read as an id.
router.get('/tournaments/history', requireAuth, requireAccount, async (req, res) => {
  res.json({ history: await tournaments.historyFor(req.user.id, 20) });
});

router.get('/tournaments/:id', requireAuth, requireAccount, async (req, res) => {
  try {
    const detail = await tournaments.detail(req.params.id);
    const entries = detail.entries.map((e) => ({ userId: e.userId, name: e.name, seed: e.seed }));
    res.json({
      ...detail,
      entries,
      joined: detail.entries.some((e) => e.userId === req.user.id),
      myClaim: await tournaments.myClaim(req.params.id, req.user.id),
      // Where this player stands and what is still between them and the title.
      milestone: await tournaments.milestoneFor(req.params.id, req.user.id),
    });
  } catch (e) {
    res.status(e.code === 'NOT_FOUND' ? 404 : 400).json({ error: e.message, code: e.code });
  }
});

// Submit proof of an off-app (UPI) payment. This does NOT grant entry — an
// admin verifies the money actually arrived and then approves it.
router.post('/tournaments/:id/claim', requireAuth, requireAccount, authLimiter, async (req, res) => {
  try {
    if (config.push.requireForTournaments && !(await push.hasSubscription(req.user.id))) {
      return res.status(403).json({
        error: 'Turn on match alerts before entering — we need to notify you when your match starts.',
        code: 'PUSH_REQUIRED',
      });
    }
    const claim = await tournaments.submitClaim(req.user, req.params.id, req.body || {});
    res.json({ ok: true, claim });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

// How to pay for this tournament: your UPI id, a prefilled deep link, and the
// player's own id so you can match the payment to the person.
router.get('/tournaments/:id/payment', requireAuth, requireAccount, async (req, res) => {
  try {
    const t = await tournaments.get(req.params.id);
    const ref = `${t.id}-${req.user.id}`.slice(0, 35);
    res.json({
      upiId: config.payments.upiId,
      upiName: config.payments.upiName,
      upiQrUrl: config.payments.upiQrUrl,
      supportUrl: config.payments.supportUrl,
      amountInr: t.entryFeeInr,
      reference: ref,
      payLink: upiPayLink({
        upiId: config.payments.upiId,
        upiName: config.payments.upiName,
        amountInr: t.entryFeeInr,
        note: `Entry ${t.title}`.slice(0, 50),
        ref,
      }),
      myClaim: await tournaments.myClaim(t.id, req.user.id),
    });
  } catch (e) {
    res.status(e.code === 'NOT_FOUND' ? 404 : 400).json({ error: e.message, code: e.code });
  }
});

// Self-service entry, coin tournaments only. Manual (UPI) entries are added by
// an admin after payment is confirmed.
router.post('/tournaments/:id/join', requireAuth, requireAccount, async (req, res) => {
  try {
    if (config.push.requireForTournaments && !(await push.hasSubscription(req.user.id))) {
      return res.status(403).json({
        error: 'Turn on match alerts before entering — we need to notify you when your match starts.',
        code: 'PUSH_REQUIRED',
      });
    }
    const t = await tournaments.get(req.params.id);
    const entry = t.entryType === 'balance'
      ? await tournaments.joinWithBalance(req.user, req.params.id)
      : await tournaments.joinWithCoins(req.user, req.params.id);
    res.json({ ok: true, entry, coins: await wallet.getBalance(req.user.id), cashInr: await cash.balance(req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

router.post('/tournaments/:id/withdraw', requireAuth, requireAccount, async (req, res) => {
  try {
    await tournaments.removeEntry(req.params.id, req.user.id);
    res.json({ ok: true, coins: await wallet.getBalance(req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

// ── Game history & leaderboard (DB-backed) ──
router.get('/me/games', requireAuth, requireAccount, async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  res.json({ games: await store.getUserGames(req.user.id, limit) });
});

router.get('/leaderboard', requireAuth, requireAccount, async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  const period = req.query.period === 'week' ? 'week' : 'all';
  const since = period === 'week' ? Date.now() - 7 * 24 * 60 * 60 * 1000 : null;
  res.json({ period, leaderboard: await store.getLeaderboard({ limit, since }) });
});
