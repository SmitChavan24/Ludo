import mysql from 'mysql2/promise';
import { newReferralCode } from '../util/referral.js';

export function createPool(cfg) {
  return mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionLimit: cfg.connectionLimit,
    waitForConnections: true,
    charset: 'utf8mb4_unicode_ci',
  });
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id                  VARCHAR(32)  PRIMARY KEY,
     provider            VARCHAR(32)  NOT NULL,
     provider_id         VARCHAR(255) NOT NULL,
     email               VARCHAR(255),
     name                VARCHAR(255),
     picture             TEXT,
     created_at          BIGINT       NOT NULL,
     last_daily_bonus_at BIGINT,
     games_played        INT          NOT NULL DEFAULT 0,
     games_won           INT          NOT NULL DEFAULT 0,
     referral_code       VARCHAR(16),
     referred_by         VARCHAR(32),
     UNIQUE KEY uniq_provider (provider, provider_id),
     UNIQUE KEY uniq_referral_code (referral_code),
     INDEX idx_referred_by (referred_by)
   ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS refresh_sessions (
     jti        VARCHAR(64) PRIMARY KEY,
     user_id    VARCHAR(32) NOT NULL,
     expires_at BIGINT      NOT NULL,
     INDEX idx_rs_user (user_id)
   ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS games (
     id        VARCHAR(32) PRIMARY KEY,
     data      JSON        NOT NULL,
     ended_at  BIGINT      NOT NULL,
     INDEX idx_games_ended (ended_at)
   ) ENGINE=InnoDB`,

  // One row per player per finished game — powers history + leaderboard queries.
  `CREATE TABLE IF NOT EXISTS game_players (
     game_id   VARCHAR(32) NOT NULL,
     user_id   VARCHAR(32) NOT NULL,
     name      VARCHAR(255),
     color     VARCHAR(16),
     is_winner TINYINT     NOT NULL DEFAULT 0,
     stake     BIGINT      NOT NULL,
     payout    BIGINT      NOT NULL DEFAULT 0,
     net       BIGINT      NOT NULL,
     ended_at  BIGINT      NOT NULL,
     PRIMARY KEY (game_id, user_id),
     INDEX idx_gp_user (user_id, ended_at),
     INDEX idx_gp_ended (ended_at)
   ) ENGINE=InnoDB`,

  // Tournaments. `bracket` holds the full single-elimination tree as JSON so
  // the shape can evolve without a migration.
  `CREATE TABLE IF NOT EXISTS tournaments (
     id             VARCHAR(32) PRIMARY KEY,
     title          VARCHAR(160) NOT NULL,
     status         VARCHAR(16)  NOT NULL,
     entry_type     VARCHAR(16)  NOT NULL,
     entry_fee_coins BIGINT      NOT NULL DEFAULT 0,
     entry_fee_inr  INT          NOT NULL DEFAULT 0,
     prize_text     VARCHAR(255),
     prize_coins    BIGINT       NOT NULL DEFAULT 0,
     max_players    INT          NOT NULL,
     starts_at      BIGINT,
     lobby_opens_at BIGINT,
     created_at     BIGINT       NOT NULL,
     finished_at    BIGINT,
     winner_id      VARCHAR(32),
     rake_bips      INT          NOT NULL DEFAULT 0,
     payout_split   VARCHAR(64)  NOT NULL DEFAULT '100',
     auto_start     TINYINT      NOT NULL DEFAULT 1,
     bracket        JSON,
     INDEX idx_t_status (status, starts_at)
   ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS tournament_entries (
     tournament_id VARCHAR(32) NOT NULL,
     user_id       VARCHAR(32) NOT NULL,
     seed          INT         NOT NULL,
     payment_ref   VARCHAR(128),
     added_by      VARCHAR(32),
     joined_at     BIGINT      NOT NULL,
     placement     INT,
     PRIMARY KEY (tournament_id, user_id),
     INDEX idx_te_user (user_id)
   ) ENGINE=InnoDB`,

  // Payment claims: a player says "I paid, here's my UTR", an admin verifies it
  // against the bank statement and approves. `utr` is UNIQUE across the whole
  // table — that single constraint is what stops one transaction reference
  // being reused for a second entry, by the same player or a different one.
  `CREATE TABLE IF NOT EXISTS tournament_claims (
     id            VARCHAR(32) PRIMARY KEY,
     tournament_id VARCHAR(32),
     purpose       VARCHAR(16) NOT NULL DEFAULT 'tournament',
     user_id       VARCHAR(32) NOT NULL,
     utr           VARCHAR(64) NOT NULL,
     amount_inr    INT         NOT NULL DEFAULT 0,
     note          VARCHAR(255),
     status        VARCHAR(16) NOT NULL,
     created_at    BIGINT      NOT NULL,
     reviewed_at   BIGINT,
     reviewed_by   VARCHAR(64),
     review_note   VARCHAR(255),
     UNIQUE KEY uniq_claim_utr (utr),
     INDEX idx_claims_status (status, created_at),
     INDEX idx_claims_tournament (tournament_id),
     INDEX idx_claims_user (user_id)
   ) ENGINE=InnoDB`,

  // One row per device/browser a player has allowed notifications on.
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
     endpoint   VARCHAR(500) NOT NULL,
     user_id    VARCHAR(32)  NOT NULL,
     p256dh     VARCHAR(255) NOT NULL,
     auth       VARCHAR(255) NOT NULL,
     created_at BIGINT       NOT NULL,
     PRIMARY KEY (endpoint(191)),
     INDEX idx_push_user (user_id)
   ) ENGINE=InnoDB`,

  // Withdrawal requests. The amount is DEBITED (held) the moment a player asks,
  // so the same rupees can't be spent while the request sits in your queue.
  // Rejecting refunds it; marking paid simply closes the request.
  `CREATE TABLE IF NOT EXISTS withdrawals (
     id          VARCHAR(32) PRIMARY KEY,
     user_id     VARCHAR(32) NOT NULL,
     amount_inr  INT         NOT NULL,
     upi_id      VARCHAR(128) NOT NULL,
     status      VARCHAR(16) NOT NULL,
     created_at  BIGINT      NOT NULL,
     reviewed_at BIGINT,
     reviewed_by VARCHAR(64),
     payment_ref VARCHAR(128),
     note        VARCHAR(255),
     INDEX idx_wd_status (status, created_at),
     INDEX idx_wd_user (user_id)
   ) ENGINE=InnoDB`,

  // Money tables.
  `CREATE TABLE IF NOT EXISTS balances (
     account_id VARCHAR(64) PRIMARY KEY,
     coins      BIGINT      NOT NULL DEFAULT 0
   ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS ledger (
     id            VARCHAR(32) PRIMARY KEY,
     account_id    VARCHAR(64) NOT NULL,
     delta         BIGINT      NOT NULL,
     reason        VARCHAR(128),
     ref_id        VARCHAR(64),
     balance_after BIGINT      NOT NULL,
     created_at    BIGINT      NOT NULL,
     INDEX idx_ledger_account (account_id, created_at)
   ) ENGINE=InnoDB`,
];

// Columns/indexes added after the first release. CREATE TABLE IF NOT EXISTS
// won't touch an existing table, so these run as idempotent ALTERs.
const MIGRATIONS = [
  { table: 'tournament_claims', column: 'purpose', sql: "ALTER TABLE tournament_claims ADD COLUMN purpose VARCHAR(16) NOT NULL DEFAULT 'tournament'" },
  { table: 'tournaments', column: 'lobby_opens_at', sql: 'ALTER TABLE tournaments ADD COLUMN lobby_opens_at BIGINT' },
  { table: 'tournaments', column: 'rake_bips', sql: 'ALTER TABLE tournaments ADD COLUMN rake_bips INT NOT NULL DEFAULT 0' },
  { table: 'tournaments', column: 'payout_split', sql: "ALTER TABLE tournaments ADD COLUMN payout_split VARCHAR(64) NOT NULL DEFAULT '100'" },
  { table: 'tournaments', column: 'auto_start', sql: 'ALTER TABLE tournaments ADD COLUMN auto_start TINYINT NOT NULL DEFAULT 1' },
  { table: 'users', column: 'referral_code', sql: 'ALTER TABLE users ADD COLUMN referral_code VARCHAR(16)' },
  { table: 'users', column: 'referred_by', sql: 'ALTER TABLE users ADD COLUMN referred_by VARCHAR(32)' },
];

const INDEXES = [
  { table: 'users', name: 'uniq_referral_code', sql: 'ALTER TABLE users ADD UNIQUE KEY uniq_referral_code (referral_code)' },
  { table: 'users', name: 'idx_referred_by', sql: 'ALTER TABLE users ADD INDEX idx_referred_by (referred_by)' },
];

async function hasColumn(pool, table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

async function hasIndex(pool, table, name) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, name],
  );
  return rows.length > 0;
}

export async function initSchema(pool) {
  for (const stmt of SCHEMA) await pool.query(stmt);

  for (const m of MIGRATIONS) {
    if (!(await hasColumn(pool, m.table, m.column))) {
      await pool.query(m.sql);
      console.log(`[storage] migrated: ${m.table}.${m.column} added`);
    }
  }
  // Deposits have no tournament, so the column must allow NULL on older installs.
  try {
    await pool.query('ALTER TABLE tournament_claims MODIFY COLUMN tournament_id VARCHAR(32) NULL');
  } catch {
    /* already nullable */
  }

  // Backfill referral codes for accounts created before the feature existed.
  const [missing] = await pool.query('SELECT id FROM users WHERE referral_code IS NULL');
  for (const row of missing) {
    // Retry on the (unlikely) chance of a code collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await pool.execute('UPDATE users SET referral_code=? WHERE id=?', [newReferralCode(), row.id]);
        break;
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') throw e;
      }
    }
  }
  if (missing.length) console.log(`[storage] backfilled referral codes for ${missing.length} user(s)`);

  for (const idx of INDEXES) {
    if (!(await hasIndex(pool, idx.table, idx.name))) {
      try {
        await pool.query(idx.sql);
      } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e;
      }
    }
  }
}
