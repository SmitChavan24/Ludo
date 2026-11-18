import { MemoryWallet } from './MemoryWallet.js';
import { WalletError } from './errors.js';

// Facade over the active wallet backend. Defaults to in-memory (tests / dev);
// `setWalletBackend` swaps in the MySQL implementation at startup. Every module
// keeps importing `{ wallet }` from here — nothing else changes when the backend
// switches.
let backend = new MemoryWallet();

export function setWalletBackend(impl) {
  backend = impl;
}

export { WalletError };

// The house account: platform fees from matches and tournaments collect here.
export const HOUSE_ACCOUNT = '__house__';

export const wallet = {
  getBalance: (...a) => backend.getBalance(...a),
  houseBalance: (...a) => backend.houseBalance(...a),
  historyFor: (...a) => backend.historyFor(...a),
  credit: (...a) => backend.credit(...a),
  creditOnce: (...a) => backend.creditOnce(...a),
  debit: (...a) => backend.debit(...a),
  escrowStakes: (...a) => backend.escrowStakes(...a),
  settlePot: (...a) => backend.settlePot(...a),
  refundStakes: (...a) => backend.refundStakes(...a),
  // Accounting reports (read-only).
  ledgerSummary: (...a) => backend.ledgerSummary(...a),
  ledgerDaily: (...a) => backend.ledgerDaily(...a),
  listLedger: (...a) => backend.listLedger(...a),
  balanceTotals: (...a) => backend.balanceTotals(...a),
};
