import { store } from '../db/store.js';
import { wallet } from '../wallet/Wallet.js';
import { config } from '../config.js';
import { normalizeReferralCode } from '../util/referral.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Look up a user by their identity provider, creating the account (and granting
// the one-time signup bonus) on first sight. The signup bonus is credited
// through the ledger like any other coin movement.
export async function findOrCreateUser(provider, profile, referralCode) {
  let user = await store.findUserByProvider(provider, profile.providerId);
  if (user) return { user, isNew: false, referral: null };

  user = await store.createUser({
    provider,
    providerId: profile.providerId,
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
  });
  if (config.economy.signupBonus > 0) {
    await wallet.credit(user.id, config.economy.signupBonus, 'signup_bonus');
  }

  // Referral reward — only ever on a brand-new account, so it can't be farmed
  // by logging in repeatedly.
  const referral = await applyReferral(user, referralCode);
  return { user, isNew: true, referral };
}

// Credit BOTH sides when a new player arrives via someone's invite code.
async function applyReferral(newUser, rawCode) {
  const bonus = config.economy.referralBonus;
  if (!rawCode || bonus <= 0) return null;

  const code = normalizeReferralCode(rawCode);
  if (!code || code === newUser.referralCode) return null; // can't refer yourself

  const referrer = await store.findUserByReferralCode(code);
  if (!referrer || referrer.id === newUser.id) return null;

  await store.setReferredBy(newUser.id, referrer.id);
  await wallet.credit(newUser.id, bonus, 'referral_bonus', referrer.id);
  await wallet.credit(referrer.id, bonus, 'referral_reward', newUser.id);

  return { referrerId: referrer.id, referrerName: referrer.name, amount: bonus };
}

// Grant the daily login bonus at most once per 24h.
export async function claimDailyBonus(userId) {
  const user = await store.getUser(userId);
  if (!user) throw new Error('User not found');

  const now = Date.now();
  if (user.lastDailyBonusAt && now - user.lastDailyBonusAt < ONE_DAY_MS) {
    return { granted: false, nextAt: user.lastDailyBonusAt + ONE_DAY_MS };
  }
  await store.setDailyBonusClaimed(userId, now);
  await wallet.credit(userId, config.economy.dailyBonus, 'daily_bonus');
  return { granted: true, amount: config.economy.dailyBonus, balance: await wallet.getBalance(userId) };
}

// A compact public profile + balance for API responses.
export async function publicProfile(user) {
  // Guests have no wallet, stats or referral code — never look them up.
  if (user.isGuest) {
    return { id: user.id, name: user.name, picture: null, email: null, coins: 0, gamesPlayed: 0, gamesWon: 0, isGuest: true };
  }
  return {
    id: user.id,
    name: user.name,
    picture: user.picture,
    email: user.email,
    coins: await wallet.getBalance(user.id),
    gamesPlayed: user.gamesPlayed,
    gamesWon: user.gamesWon,
    referralCode: user.referralCode || null,
  };
}
