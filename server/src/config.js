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

// Refuse to run with settings that would be catastrophic in production. It is
// far better to fail loudly at boot than to serve real money with a default
// password or a placeholder secret.
function assertProductionSafety(cfg) {
  if (!cfg.isProd) return;
  const problems = [];

  const weak = ['', 'admin', 'password', 'changeme', '123456', 'admin123'];
  if (!cfg.admin.password) problems.push('ADMIN_PASSWORD is not set — the admin page would be unusable.');
  else if (weak.includes(cfg.admin.password.toLowerCase())) problems.push('ADMIN_PASSWORD is a well-known weak password.');
  else if (cfg.admin.password.length < 12) problems.push('ADMIN_PASSWORD must be at least 12 characters.');

  if (cfg.admin.apiKey && cfg.admin.apiKey.length < 24) problems.push('ADMIN_API_KEY is too short to be safe.');
  for (const [name, value] of [['JWT_ACCESS_SECRET', cfg.jwt.accessSecret], ['JWT_REFRESH_SECRET', cfg.jwt.refreshSecret]]) {
    if (value.includes('replace-me') || value.length < 32) problems.push(`${name} is a placeholder or too short.`);
  }
  if (cfg.jwt.accessSecret === cfg.jwt.refreshSecret) problems.push('JWT access and refresh secrets must differ.');
  if (cfg.allowDevLogin) problems.push('Dev login must never be enabled in production.');
  if (cfg.clientOrigins.some((o) => o.includes('localhost'))) {
    console.warn('[config] WARNING: CLIENT_ORIGINS still contains localhost in production.');
  }

  if (problems.length) {
    console.error('\n✖ Refusing to start — unsafe production configuration:');
    for (const p of problems) console.error(`   • ${p}`);
    console.error('');
    process.exit(1);
  }
}

export const config = {
  env,
  isProd,
  port: int('PORT', 4000),
  clientOrigins: (process.env.CLIENT_ORIGINS || 'http://localhost:5174')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // In production the Node server also serves the built client (same origin),
  // so no separate web server is needed. Override with SERVE_CLIENT.
  serveClient: process.env.SERVE_CLIENT ? process.env.SERVE_CLIENT === 'true' : isProd,
  clientDist: process.env.CLIENT_DIST || null,
  jwt: {
    accessSecret: secret('JWT_ACCESS_SECRET'),
    refreshSecret: secret('JWT_REFRESH_SECRET'),
    accessTtl: int('JWT_ACCESS_TTL', 900),
    refreshTtl: int('JWT_REFRESH_TTL', 2592000),
  },
  googleClientId: optional('GOOGLE_CLIENT_ID'),
  // Admin / CRM access.
  admin: {
    // Shared secret for server-to-server CRM calls (`x-admin-key` header).
    // If unset, the API-key path is disabled.
    apiKey: process.env.ADMIN_API_KEY || null,
    // Credentials for the admin WEB PAGE (logs in for a short-lived admin JWT).
    // Web login is disabled unless a password is set.
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || null,
    jwtTtl: int('ADMIN_JWT_TTL', 1800), // admin session length, seconds (30 min)
    // Brute-force protection for the admin login.
    maxLoginAttempts: int('ADMIN_MAX_LOGIN_ATTEMPTS', 5),
    lockoutMs: int('ADMIN_LOCKOUT_MS', 15 * 60_000),
    lockoutWindowMs: int('ADMIN_LOCKOUT_WINDOW_MS', 15 * 60_000),
    // If set, ONLY these IPs may reach /api/admin at all.
    ipAllowlist: (process.env.ADMIN_IP_ALLOWLIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  // Dev login is only ever enabled outside production.
  allowDevLogin: process.env.ALLOW_DEV_LOGIN === 'true' && !isProd,
  // Off-app payment details shown to players for MANUAL-entry tournaments.
  // The app never processes these — it only displays how to pay, and an admin
  // confirms receipt and adds the player.
  payments: {
    upiId: process.env.UPI_ID || '',
    upiName: process.env.UPI_NAME || '',
    // Optional image served from the client's public folder, e.g. /upi-qr.png
    upiQrUrl: process.env.UPI_QR_URL || '',
    supportUrl: process.env.SUPPORT_URL || '',
  },
  // Web push (VAPID). Without keys, push is simply disabled — nothing breaks.
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    get enabled() {
      return !!(this.publicKey && this.privateKey);
    },
    // Require an ACTIVE push subscription before a player can take part.
    // Tournaments genuinely depend on it (players must be reachable when their
    // match is drawn). Gating practice too is a conversion trade-off — it asks
    // for a scary permission before the player has seen any value.
    requireForTournaments: process.env.REQUIRE_PUSH_TOURNAMENTS !== 'false',
    requireForPractice: process.env.REQUIRE_PUSH_PRACTICE !== 'false',
  },
  // Practice mode: anyone can play a no-stakes game without an account. A bot
  // fills the table if no real opponent turns up, so a first-time visitor can
  // ALWAYS play immediately instead of staring at an empty lobby.
  practice: {
    enabled: process.env.PRACTICE_ENABLED !== 'false',
    guestTtl: int('GUEST_TTL', 60 * 60 * 6), // guest session lifetime, seconds
    botWaitMs: int('PRACTICE_BOT_WAIT_MS', 20000), // wait for a human before the bot joins
    botMinThinkMs: int('BOT_MIN_THINK_MS', 700), // bot "thinking" delay, lower bound
    botMaxThinkMs: int('BOT_MAX_THINK_MS', 1400),
  },
  // Storage backend. 'memory' (default) resets on restart; 'mysql' persists.
  db: {
    driver: process.env.DB_DRIVER || 'memory',
    host: process.env.DB_HOST || '127.0.0.1',
    port: int('DB_PORT', 3306),
    user: process.env.DB_USER || 'coinludo',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'coinludo',
    connectionLimit: int('DB_POOL', 10),
  },
  // Real money held on behalf of players. Whole rupees only — the tournament
  // economics module is integer-rupee throughout, so the wallet matches it.
  cash: {
    minDepositInr: int('MIN_DEPOSIT_INR', 50),
    minWithdrawalInr: int('MIN_WITHDRAWAL_INR', 100),
    // A player cannot withdraw more than this in one request (fraud blast radius).
    maxWithdrawalInr: int('MAX_WITHDRAWAL_INR', 10000),
  },
  economy: {
    // NOTE: these bonuses are paid in PRACTICE COINS, never cash. They cost you
    // nothing and exist purely to make casual play and referrals feel rewarding.
    signupBonus: int('SIGNUP_BONUS_COINS', 1000),
    dailyBonus: int('DAILY_BONUS_COINS', 100),
    // Coins paid to BOTH the inviter and the new player on a referred signup.
    referralBonus: int('REFERRAL_BONUS_COINS', 500),
    rakeBips: int('RAKE_BIPS', 500),
    turnTimeoutMs: int('TURN_TIMEOUT_MS', 30000),
    // Grace after a disconnect before the player forfeits (allows quick reconnects).
    disconnectGraceMs: int('DISCONNECT_GRACE_MS', 25000),
    // ── Matchmaking liquidity ──
    // The ONLY stakes and table sizes players may choose. Keep this list SHORT at
    // launch: every extra combination splits your player pool into another queue,
    // and a split pool means nobody ever gets matched. Widen as traffic grows.
    stakes: (process.env.STAKES || '50')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0),
    // Minutes of "lobby" before a tournament starts: registration closes, the
    // players who paid gather, and everyone gets a countdown + notification.
    lobbyMinutes: int('TOURNAMENT_LOBBY_MINUTES', 10),
    playerCounts: (process.env.PLAYER_COUNTS || '2')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => [2, 3, 4].includes(n)),
  },
  // Per-socket event flood protection. Generous vs. real play (a human sends a
  // few events per turn); anything above this is abuse, not gameplay.
  socketRate: {
    windowMs: int('SOCKET_RATE_WINDOW_MS', 1000),
    max: int('SOCKET_RATE_MAX', 60),
  },
};

assertProductionSafety(config);
