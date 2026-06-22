import mysql from 'mysql2/promise';

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
     UNIQUE KEY uniq_provider (provider, provider_id)
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

export async function initSchema(pool) {
  for (const stmt of SCHEMA) await pool.query(stmt);
}
