import { Router } from 'express';
import { requireAdmin } from '../middleware/admin.js';
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
adminRouter.use(requireAdmin);

const parseAmount = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Confirm an account exists + see its balance and recent ledger before crediting.
adminRouter.get('/users/:id', (req, res) => {
  const user = store.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      coins: wallet.getBalance(user.id),
      gamesPlayed: user.gamesPlayed,
      gamesWon: user.gamesWon,
      createdAt: user.createdAt,
    },
    history: wallet.historyFor(user.id, 20),
  });
});

// Credit coins (the CRM top-up after an external payment).
adminRouter.post('/credit', async (req, res) => {
  const { userId, amount, reason } = req.body || {};
  if (!userId || !store.getUser(userId)) return res.status(404).json({ error: 'User not found' });
  const amt = parseAmount(amount);
  if (!amt) return res.status(400).json({ error: 'amount must be a positive integer' });

  const tag = reason ? `crm:${String(reason).slice(0, 64)}` : 'crm_topup';
  const entry = await wallet.credit(userId, amt, tag);
  res.json({ ok: true, userId, credited: amt, reason: tag, balance: entry.balanceAfter });
});

// Debit coins (manual corrections / refunds).
adminRouter.post('/debit', async (req, res) => {
  const { userId, amount, reason } = req.body || {};
  if (!userId || !store.getUser(userId)) return res.status(404).json({ error: 'User not found' });
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
