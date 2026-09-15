import { verifyAccessToken, guestFromPayload } from '../auth/jwt.js';
import { store } from '../db/store.js';

// Express guard: requires a valid, unexpired Bearer access token and attaches
// the live user record to req.user. Used on every protected REST route.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing access token' });

  try {
    const payload = verifyAccessToken(token);
    const guest = guestFromPayload(payload);
    if (guest) {
      // Guests may identify themselves but own nothing — routes that touch the
      // wallet or a profile must reject them (see requireAccount).
      req.user = guest;
      return next();
    }
    const user = await store.getUser(payload.sub);
    if (!user) return res.status(401).json({ error: 'Unknown user' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Stricter guard for anything involving coins, stats or referrals: a guest has
// no account, so these must never be reachable with a guest token.
export function requireAccount(req, res, next) {
  if (req.user?.isGuest) {
    return res.status(403).json({ error: 'Sign in to use this feature', code: 'GUEST_FORBIDDEN' });
  }
  next();
}
