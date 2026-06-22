import { config } from '../config.js';
import { createPool, initSchema } from './mysql.js';
import { MysqlStore } from './MysqlStore.js';
import { MysqlWallet } from '../wallet/MysqlWallet.js';
import { setStoreBackend } from './store.js';
import { setWalletBackend } from '../wallet/Wallet.js';

let pool = null;

export function getPool() {
  return pool;
}

// Decide and wire the storage backend once, at startup. With DB_DRIVER=mysql we
// connect, ensure the schema exists, and swap the store + wallet to MySQL.
// Otherwise we stay on the in-memory backend (handy for quick local runs/tests).
export async function initStorage() {
  if (config.db.driver !== 'mysql') {
    console.log('[storage] in-memory backend — data resets on restart. Set DB_DRIVER=mysql to persist.');
    return;
  }

  pool = createPool(config.db);
  await pool.query('SELECT 1'); // fail fast if the DB is unreachable
  await initSchema(pool);
  setStoreBackend(new MysqlStore(pool));
  setWalletBackend(new MysqlWallet(pool));
  console.log(`[storage] MySQL backend at ${config.db.host}:${config.db.port}/${config.db.database}`);
}

export async function closeStorage() {
  if (pool) await pool.end();
}
