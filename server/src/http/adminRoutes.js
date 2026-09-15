import { Router } from 'express';
import { requireAdmin } from '../middleware/admin.js';
import { loginAttemptGuard, recordFailedLogin, clearFailedLogins, ipAllowlist } from '../middleware/adminGuard.js';
import { audit } from '../util/audit.js';
import { signAdminToken } from '../auth/jwt.js';
import { safeEqual } from '../util/safeEqual.js';
import { config } from '../config.js';
import { authLimiter } from '../middleware/security.js';
import { wallet } from '../wallet/Wallet.js';
import { store } from '../db/store.js';
import { tournaments } from '../tournament/TournamentService.js';
import { push } from '../push/PushService.js';
import { cash } from '../cash/CashService.js';

// ──────────────────────────────────────────────────────────────────────────
// Admin / CRM endpoints. All credit by EXACT user id (no fuzzy search) so a
// support agent can top up a player's coins after taking payment externally.
//
// Every call goes through the coin ledger, so admin top-ups are auditable just
// like any other balance change.
// ──────────────────────────────────────────────────────────────────────────
export const adminRouter = Router();

// Nothing on the admin surface is reachable from outside the allowlist (if set).
adminRouter.use(ipAllowlist);

// PUBLIC: admin web-page login. Verifies username + password (constant-time)
// and issues a short-lived admin JWT used as the Bearer token for everything
// below. Disabled unless ADMIN_PASSWORD is configured.
adminRouter.post('/login', authLimiter, loginAttemptGuard, (req, res) => {
  if (!config.admin.password) {
    return res.status(503).json({ error: 'Admin login is not configured (set ADMIN_PASSWORD).' });
  }
  const { username, password } = req.body || {};
  const ok = safeEqual(username, config.admin.username) && safeEqual(password, config.admin.password);
  if (!ok) {
    recordFailedLogin(req);
    audit.record({ actor: 'anonymous', action: 'admin_login_failed', req });
    // Deliberately vague: never reveal whether the username or password was wrong.
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  clearFailedLogins(req);
  audit.record({ actor: config.admin.username, action: 'admin_login', req });
  res.json({ token: signAdminToken(config.admin.username), expiresIn: config.admin.jwtTtl });
});

// Everything past this point requires admin auth (admin JWT or x-admin-key).
adminRouter.use(requireAdmin);

// Audit trail: every admin action that changes something is recorded with who,
// what, when and from where. Money and tournament results must be attributable.
adminRouter.use((req, res, next) => {
  if (req.method === 'GET') return next();
  audit.record({
    actor: req.admin?.sub || 'api-key',
    action: `${req.method} ${req.path}`,
    detail: req.body,
    req,
  });
  next();
});

const parseAmount = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Confirm an account exists + see its balance and recent ledger before crediting.
adminRouter.get('/users/:id', async (req, res) => {
  const user = await store.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      coins: await wallet.getBalance(user.id),
      gamesPlayed: user.gamesPlayed,
      gamesWon: user.gamesWon,
      createdAt: user.createdAt,
    },
    history: await wallet.historyFor(user.id, 20),
  });
});

// Credit coins (the CRM top-up after an external payment).
adminRouter.post('/credit', async (req, res) => {
  const { userId, amount, reason } = req.body || {};
  if (!userId || !(await store.getUser(userId))) return res.status(404).json({ error: 'User not found' });
  const amt = parseAmount(amount);
  if (!amt) return res.status(400).json({ error: 'amount must be a positive integer' });

  const tag = reason ? `crm:${String(reason).slice(0, 64)}` : 'crm_topup';
  const entry = await wallet.credit(userId, amt, tag);
  res.json({ ok: true, userId, credited: amt, reason: tag, balance: entry.balanceAfter });
});

// Debit coins (manual corrections / refunds).
adminRouter.post('/debit', async (req, res) => {
  const { userId, amount, reason } = req.body || {};
  if (!userId || !(await store.getUser(userId))) return res.status(404).json({ error: 'User not found' });
  const amt = parseAmount(amount);
  if (!amt) return res.status(400).json({ error: 'amount must be a positive integer' });

  try {
    const tag = reason ? `crm:${String(reason).slice(0, 64)}` : 'crm_adjust';
    const entry = await wallet.debit(userId, amt, tag);
    res.json({ ok: true, userId, debited: amt, reason: tag, balance: entry.balanceAfter });
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Tournaments — your control panel.
//
// For MANUAL (UPI) tournaments the flow is:
//   1. create the tournament
//   2. player pays you off-app and sends their Player ID
//   3. you confirm receipt, then POST /entries with their id + a payment ref
//   4. start it — the bracket is drawn and matches begin
// The payment reference is your audit trail; keep it meaningful (UPI UTR etc).
// ──────────────────────────────────────────────────────────────────────────
const fail = (res, e) => res.status(e.code === 'NOT_FOUND' ? 404 : 400).json({ error: e.message, code: e.code });

adminRouter.get('/tournaments', async (req, res) => {
  res.json({ tournaments: await tournaments.list({ status: req.query.status || null, limit: 100 }) });
});

adminRouter.post('/tournaments', async (req, res) => {
  try {
    res.json({ ok: true, tournament: await tournaments.create(req.body || {}) });
  } catch (e) {
    fail(res, e);
  }
});

adminRouter.get('/tournaments/:id', async (req, res) => {
  try {
    res.json(await tournaments.detail(req.params.id));
  } catch (e) {
    fail(res, e);
  }
});

// Add a player after confirming an off-app (UPI) payment.
adminRouter.post('/tournaments/:id/entries', async (req, res) => {
  try {
    const { userId, paymentRef } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const entry = await tournaments.addEntryManually(req.params.id, userId, {
      paymentRef,
      addedBy: req.admin?.sub || 'admin',
    });
    res.json({ ok: true, entry });
  } catch (e) {
    fail(res, e);
  }
});

adminRouter.delete('/tournaments/:id/entries/:userId', async (req, res) => {
  try {
    await tournaments.removeEntry(req.params.id, req.params.userId);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

adminRouter.post('/tournaments/:id/start', async (req, res) => {
  try {
    res.json({ ok: true, ...(await tournaments.start(req.params.id)) });
  } catch (e) {
    fail(res, e);
  }
});

// Record a result manually (e.g. a match played outside the app, or a dispute).
adminRouter.post('/tournaments/:id/result', async (req, res) => {
  try {
    const { matchId, winnerId, endedBy } = req.body || {};
    if (!matchId || !winnerId) return res.status(400).json({ error: 'matchId and winnerId are required' });
    // Default to 'admin' rather than 'played': a result typed in by hand should
    // say so to the player, not claim the game was fought out on the board.
    const allowed = ['admin', 'played', 'forfeit', 'disconnect', 'inactivity'];
    const meta = { endedBy: allowed.includes(endedBy) ? endedBy : 'admin' };
    res.json({ ok: true, ...(await tournaments.recordResult(req.params.id, matchId, winnerId, meta)) });
  } catch (e) {
    fail(res, e);
  }
});

adminRouter.post('/tournaments/:id/cancel', async (req, res) => {
  try {
    res.json({ ok: true, tournament: await tournaments.cancel(req.params.id, { refund: req.body?.refund !== false }) });
  } catch (e) {
    fail(res, e);
  }
});

// Permanent removal, for clearing out finished and cancelled tournaments. The
// service refuses while a tournament still holds seats or unreviewed payments.
adminRouter.delete('/tournaments/:id', async (req, res) => {
  try {
    const result = await tournaments.remove(req.params.id);
    audit.record({
      actor: config.admin.username,
      action: 'tournament_deleted',
      detail: { id: result.id, title: result.title },
      req,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    fail(res, e);
  }
});

// ── Payment review queue ──
// The heart of the manual-payment flow: players submit a UTR, you check it
// against your bank statement, then approve (grants entry) or reject (with a
// reason the player can act on).
adminRouter.get('/claims', async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({
    claims: await tournaments.listClaims({
      status,
      tournamentId: req.query.tournamentId || null,
      limit: 200,
    }),
  });
});

adminRouter.post('/claims/:id/approve', async (req, res) => {
  try {
    const result = await tournaments.approveClaim(req.params.id, {
      reviewedBy: req.admin?.sub || 'admin',
      note: req.body?.note,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    fail(res, e);
  }
});

adminRouter.post('/claims/:id/reject', async (req, res) => {
  try {
    const claim = await tournaments.rejectClaim(req.params.id, {
      reviewedBy: req.admin?.sub || 'admin',
      reason: req.body?.reason,
    });
    res.json({ ok: true, claim });
  } catch (e) {
    fail(res, e);
  }
});

// ── Business overview ──
// Everything is derived from what has actually been collected — no projections
// dressed up as revenue.
adminRouter.get('/stats', async (req, res) => {
  const all = await tournaments.list({ limit: 200 });
  const claims = await tournaments.listClaims({ status: 'pending', limit: 200 });

  let collected = 0;
  let yourCut = 0;
  let prizes = 0;
  let entries = 0;
  const byStatus = { open: 0, running: 0, finished: 0, cancelled: 0 };

  const rows = [];
  for (const t of all) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    const list = await store.listTournamentEntries(t.id);
    const money = tournaments.financialsFor(t, list.length);
    entries += list.length;
    // Cancelled events collected nothing in the end — exclude them from revenue.
    if (t.status !== 'cancelled') {
      collected += money.collectedInr;
      yourCut += money.yourCutInr;
      prizes += money.prizePoolInr;
    }
    rows.push({
      id: t.id,
      title: t.title,
      status: t.status,
      entryType: t.entryType,
      startsAt: t.startsAt,
      players: list.length,
      maxPlayers: t.maxPlayers,
      entryFeeInr: t.entryFeeInr,
      rakeBips: t.rakeBips,
      collectedInr: money.collectedInr,
      yourCutInr: money.yourCutInr,
      prizePoolInr: money.prizePoolInr,
      winnerId: t.winnerId,
    });
  }

  res.json({
    totals: {
      tournaments: all.length,
      byStatus,
      entries,
      collectedInr: collected,
      yourCutInr: yourCut,        // your revenue
      prizePoolInr: prizes,       // owed to / paid to players
      pendingClaims: claims.length,
      houseCoins: await wallet.houseBalance(),
    },
    tournaments: rows,
    pendingClaims: claims,
  });
});

// What you owe the winners of a finished tournament.
adminRouter.get('/tournaments/:id/prizes', async (req, res) => {
  try {
    res.json({ prizes: await tournaments.prizeSheet(req.params.id) });
  } catch (e) {
    fail(res, e);
  }
});

// ── Send a custom notification ──
// target: 'all' | 'tournament' (everyone entered in one) | 'user' (a single id)
adminRouter.post('/notify', async (req, res) => {
  const { target = 'all', title, body, url, tournamentId, userId } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'A title is required' });
  if (!push.enabled) return res.status(503).json({ error: 'Push is not configured (set VAPID keys)' });

  const payload = {
    title: String(title).slice(0, 80),
    body: String(body || '').slice(0, 200),
    url: url || '/',
    tag: `admin-${Date.now()}`,
  };

  try {
    let result;
    if (target === 'user') {
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      result = { ...(await push.sendToUser(userId, payload)), recipients: 1 };
    } else if (target === 'tournament') {
      if (!tournamentId) return res.status(400).json({ error: 'tournamentId is required' });
      const entries = await store.listTournamentEntries(tournamentId);
      result = { ...(await push.sendToUsers(entries.map((e) => e.userId), payload)), recipients: entries.length };
    } else {
      result = await push.sendToAll(payload);
    }
    res.json({ ok: true, ...result, payload });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// How many people can you actually reach?
adminRouter.get('/notify/reach', async (req, res) => {
  const userIds = await store.listAllPushUserIds();
  res.json({ enabled: push.enabled, subscribers: userIds.length });
});

// ── Money queues: deposits in, withdrawals out ──
adminRouter.get('/deposits', async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({ deposits: await store.listClaims({ status, purpose: 'deposit', limit: 200 }) });
});

adminRouter.post('/deposits/:id/approve', async (req, res) => {
  try {
    res.json({ ok: true, ...(await cash.approveDeposit(req.params.id, {
      reviewedBy: req.admin?.sub || 'admin',
      amountInr: req.body?.amountInr,
      note: req.body?.note,
    })) });
  } catch (e) {
    fail(res, e);
  }
});

adminRouter.post('/deposits/:id/reject', async (req, res) => {
  try {
    res.json({ ok: true, claim: await cash.rejectDeposit(req.params.id, {
      reviewedBy: req.admin?.sub || 'admin',
      reason: req.body?.reason,
    }) });
  } catch (e) {
    fail(res, e);
  }
});

adminRouter.get('/withdrawals', async (req, res) => {
  const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({ withdrawals: await store.listWithdrawals({ status, limit: 200 }) });
});

adminRouter.post('/withdrawals/:id/paid', async (req, res) => {
  try {
    res.json({ ok: true, withdrawal: await cash.markWithdrawalPaid(req.params.id, {
      reviewedBy: req.admin?.sub || 'admin',
      paymentRef: req.body?.paymentRef,
      note: req.body?.note,
    }) });
  } catch (e) {
    fail(res, e);
  }
});

adminRouter.post('/withdrawals/:id/reject', async (req, res) => {
  try {
    res.json({ ok: true, withdrawal: await cash.rejectWithdrawal(req.params.id, {
      reviewedBy: req.admin?.sub || 'admin',
      reason: req.body?.reason,
    }) });
  } catch (e) {
    fail(res, e);
  }
});

// Recent admin activity — who did what, from where.
adminRouter.get('/audit', (req, res) => {
  res.json({ entries: audit.list(parseInt(req.query.limit, 10) || 100) });
});
