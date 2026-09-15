import { config } from '../config.js';

// ──────────────────────────────────────────────────────────────────────────
// Extra protection for the admin surface, which is the highest-value target in
// the whole system: it can move money and decide tournament results.
//
//   • Brute-force lockout — a password can be guessed given enough attempts,
//     so attempts are counted per IP and the door closes for a while.
//   • Optional IP allowlist — if you only ever admin from known addresses,
//     nothing else can even reach the login form.
// ──────────────────────────────────────────────────────────────────────────

const attempts = new Map(); // ip -> { count, firstAt, lockedUntil }

function clientIp(req) {
  // Behind a proxy, Express populates req.ip from X-Forwarded-For only when
  // `trust proxy` is set — which index.js does for production.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function loginAttemptGuard(req, res, next) {
  const ip = clientIp(req);
  const rec = attempts.get(ip);
  const now = Date.now();

  if (rec?.lockedUntil && rec.lockedUntil > now) {
    const mins = Math.ceil((rec.lockedUntil - now) / 60_000);
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      code: 'LOCKED_OUT',
    });
  }
  // The window has passed — forget the old failures.
  if (rec && now - rec.firstAt > config.admin.lockoutWindowMs) attempts.delete(ip);
  next();
}

export function recordFailedLogin(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, firstAt: now, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= config.admin.maxLoginAttempts) {
    rec.lockedUntil = now + config.admin.lockoutMs;
    rec.count = 0;
    rec.firstAt = now;
    console.warn(`[admin] locked out ${ip} after repeated failed logins`);
  }
  attempts.set(ip, rec);
}

export function clearFailedLogins(req) {
  attempts.delete(clientIp(req));
}

// Optional hard boundary: only these addresses may touch /api/admin at all.
export function ipAllowlist(req, res, next) {
  const list = config.admin.ipAllowlist;
  if (!list.length) return next();
  const ip = clientIp(req).replace(/^::ffff:/, ''); // unwrap IPv4-mapped IPv6
  if (list.includes(ip)) return next();
  console.warn(`[admin] blocked admin request from ${ip}`);
  return res.status(403).json({ error: 'Not available from this address' });
}
