import { verifyAccessToken } from '../auth/jwt.js';
import { store } from '../db/store.js';

// Express guard: requires a valid, unexpired Bearer access token and attaches
// the live user record to req.user. Used on every protected REST route.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing access token' });

  try {
    const payload = verifyAccessToken(token);
    const user = store.getUser(payload.sub);
    if (!user) return res.status(401).json({ error: 'Unknown user' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
