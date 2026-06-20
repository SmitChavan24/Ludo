import { store } from '../db/store.js';
import { wallet } from '../wallet/Wallet.js';
import { config } from '../config.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Look up a user by their identity provider, creating the account (and granting
// the one-time signup bonus) on first sight. The signup bonus is credited
// through the ledger like any other coin movement.
export async function findOrCreateUser(provider, profile) {
  let user = store.findUserByProvider(provider, profile.providerId);
  if (user) return { user, isNew: false };

  user = store.createUser({
    provider,
    providerId: profile.providerId,
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
  });
  if (config.economy.signupBonus > 0) {
    await wallet.credit(user.id, config.economy.signupBonus, 'signup_bonus');
  }
  return { user, isNew: true };
}

// Grant the daily login bonus at most once per 24h.
export async function claimDailyBonus(userId) {
  const user = store.getUser(userId);
  if (!user) throw new Error('User not found');

  const now = Date.now();
  if (user.lastDailyBonusAt && now - user.lastDailyBonusAt < ONE_DAY_MS) {
    return { granted: false, nextAt: user.lastDailyBonusAt + ONE_DAY_MS };
  }
  user.lastDailyBonusAt = now;
  await wallet.credit(userId, config.economy.dailyBonus, 'daily_bonus');
  return { granted: true, amount: config.economy.dailyBonus, balance: wallet.getBalance(userId) };
}

// A compact public profile + balance for API responses.
export function publicProfile(user) {
  return {
    id: user.id,
    name: user.name,
    picture: user.picture,
    email: user.email,
    coins: wallet.getBalance(user.id),
    gamesPlayed: user.gamesPlayed,
    gamesWon: user.gamesWon,
  };
}
