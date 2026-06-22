import { Router } from 'express';
import { verifyGoogleIdToken } from '../auth/google.js';
import {
  signAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from '../auth/jwt.js';
import { findOrCreateUser, claimDailyBonus, publicProfile } from '../auth/accountService.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/security.js';
import { wallet } from '../wallet/Wallet.js';
import { store } from '../db/store.js';
import { config } from '../config.js';

export const router = Router();

async function issueTokens(user) {
  return {
    accessToken: signAccessToken(user),
    refreshToken: await issueRefreshToken(user),
    expiresIn: config.jwt.accessTtl,
  };
}

router.get('/health', (req, res) => res.json({ ok: true, env: config.env }));

// ── Google Sign-In: browser sends Google's ID token, we verify & issue ours ──
router.post('/auth/google', authLimiter, async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });
    const profile = await verifyGoogleIdToken(idToken);
    const { user, isNew } = await findOrCreateUser('google', profile);
    res.json({ ...(await issueTokens(user)), user: await publicProfile(user), isNew });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Google login failed' });
  }
});

// ── Dev-only passwordless login for local testing (disabled in production) ──
if (config.allowDevLogin) {
  router.post('/auth/dev', authLimiter, async (req, res) => {
    const rawName = (req.body?.name || 'Guest').toString().slice(0, 24);
    const slug = rawName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'guest';
    const profile = { providerId: `dev-${slug}`, email: null, name: rawName, picture: null };
    const { user, isNew } = await findOrCreateUser('dev', profile);
    res.json({ ...(await issueTokens(user)), user: await publicProfile(user), isNew });
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

router.post('/me/daily-bonus', requireAuth, async (req, res) => {
  const result = await claimDailyBonus(req.user.id);
  res.json(result);
});

router.get('/wallet', requireAuth, async (req, res) => {
  res.json({
    coins: await wallet.getBalance(req.user.id),
    history: await wallet.historyFor(req.user.id, 50),
  });
});

// ── Game history & leaderboard (DB-backed) ──
router.get('/me/games', requireAuth, async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  res.json({ games: await store.getUserGames(req.user.id, limit) });
});

router.get('/leaderboard', requireAuth, async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  const period = req.query.period === 'week' ? 'week' : 'all';
  const since = period === 'week' ? Date.now() - 7 * 24 * 60 * 60 * 1000 : null;
  res.json({ period, leaderboard: await store.getLeaderboard({ limit, since }) });
});
