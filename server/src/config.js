import 'dotenv/config';
import crypto from 'node:crypto';

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

const int = (name, def) => {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
};

// In production, secrets MUST be provided. In dev we fall back to an ephemeral
// random secret (and shout about it) so you can run without setup — tokens just
// won't survive a restart.
const secret = (name) => {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`[config] ${name} is required in production`);
  console.warn(`[config] ${name} not set — using an ephemeral dev secret (tokens reset on restart).`);
  return crypto.randomBytes(48).toString('hex');
};

const optional = (name) => {
  const v = process.env[name];
  if (!v && isProd && name === 'GOOGLE_CLIENT_ID') {
    console.warn('[config] GOOGLE_CLIENT_ID not set — Google login will be unavailable.');
  }
  return v || null;
};

export const config = {
  env,
  isProd,
  port: int('PORT', 4000),
  clientOrigins: (process.env.CLIENT_ORIGINS || 'http://localhost:5174')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  jwt: {
    accessSecret: secret('JWT_ACCESS_SECRET'),
    refreshSecret: secret('JWT_REFRESH_SECRET'),
    accessTtl: int('JWT_ACCESS_TTL', 900),
    refreshTtl: int('JWT_REFRESH_TTL', 2592000),
  },
  googleClientId: optional('GOOGLE_CLIENT_ID'),
  // Shared secret the CRM/admin tooling sends as `x-admin-key` to credit coins.
  // If unset, all admin endpoints are disabled (return 503).
  adminApiKey: process.env.ADMIN_API_KEY || null,
  // Dev login is only ever enabled outside production.
  allowDevLogin: process.env.ALLOW_DEV_LOGIN === 'true' && !isProd,
  economy: {
    signupBonus: int('SIGNUP_BONUS_COINS', 1000),
    dailyBonus: int('DAILY_BONUS_COINS', 100),
    rakeBips: int('RAKE_BIPS', 500),
    turnTimeoutMs: int('TURN_TIMEOUT_MS', 30000),
  },
};
