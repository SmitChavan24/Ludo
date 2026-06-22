import { Router } from 'express';
import { requireAdmin } from '../middleware/admin.js';
import { signAdminToken } from '../auth/jwt.js';
import { safeEqual } from '../util/safeEqual.js';
import { config } from '../config.js';
import { wallet } from '../wallet/Wallet.js';
import { store } from '../db/store.js';

// ──────────────────────────────────────────────────────────────────────────
// Admin / CRM endpoints. All credit by EXACT user id (no fuzzy search) so a
// support agent can top up a player's coins after taking payment externally.
//
// Every call goes through the coin ledger, so admin top-ups are auditable just
// like any other balance change.
// ──────────────────────────────────────────────────────────────────────────
export const adminRouter = Router();

// PUBLIC: admin web-page login. Verifies username + password (constant-time)
// and issues a short-lived admin JWT used as the Bearer token for everything
// below. Disabled unless ADMIN_PASSWORD is configured.
adminRouter.post('/login', (req, res) => {
  if (!config.admin.password) {
    return res.status(503).json({ error: 'Admin login is not configured (set ADMIN_PASSWORD).' });
  }
  const { username, password } = req.body || {};
  const ok = safeEqual(username, config.admin.username) && safeEqual(password, config.admin.password);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signAdminToken(config.admin.username), expiresIn: config.admin.jwtTtl });
});

// Everything past this point requires admin auth (admin JWT or x-admin-key).
adminRouter.use(requireAdmin);

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
