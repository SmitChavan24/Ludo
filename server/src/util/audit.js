// Admin audit trail.
//
// Money movements are already reconstructable from the coin/cash ledger, but
// the ledger doesn't say WHO approved something or from where. For a system
// where one person can credit balances and decide tournament winners, that
// attribution is what makes an incident investigable after the fact.
//
// Kept in memory + stdout by default so it works with any storage backend;
// in production your process logs are the durable copy.
const MAX_IN_MEMORY = 500;

// Never write a password, token or key into a log line.
const REDACT = /^(password|token|apiKey|accessToken|refreshToken|secret|utr)$/i;

function sanitize(value, depth = 0) {
  if (value == null || depth > 3) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT.test(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return typeof value === 'string' ? value.slice(0, 200) : value;
}

export class AuditLog {
  constructor() {
    this.entries = [];
    // Optional durable store ({ save(entry), list(limit) }), set at startup
    // when MySQL is in use, so the trail survives restarts.
    this.persist = null;
  }

  usePersistence(persist) {
    this.persist = persist;
  }

  record({ actor = 'unknown', action, detail = null, req = null }) {
    const entry = {
      at: Date.now(),
      actor,
      action,
      ip: req ? (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '') : null,
      detail: detail ? sanitize(detail) : null,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_IN_MEMORY) this.entries.shift();
    console.log(`[audit] ${entry.actor} ${entry.action} from ${entry.ip}`);
    this.persist?.save(entry).catch((err) => console.error('[audit] could not save entry:', err.message));
    return entry;
  }

  async list(limit = 100) {
    if (this.persist) return this.persist.list(limit);
    return this.entries.slice(-limit).reverse();
  }
}

export const audit = new AuditLog();
