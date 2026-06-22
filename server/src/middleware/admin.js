import { config } from '../config.js';
import { verifyAdminToken } from '../auth/jwt.js';
import { safeEqual } from '../util/safeEqual.js';

// Guards the admin/CRM endpoints. Two accepted credentials:
//   1. `Authorization: Bearer <adminJWT>` — used by the admin WEB PAGE after a
//      username/password login (the JWT-protected path you asked for).
//   2. `x-admin-key: <ADMIN_API_KEY>`     — used by your CRM, server-to-server.
export function requireAdmin(req, res, next) {
  // 1. Admin JWT (web page).
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (bearer) {
    try {
      req.admin = verifyAdminToken(bearer);
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired admin session' });
    }
  }

  // 2. API key (CRM).
  const key = req.headers['x-admin-key'];
  if (key) {
    if (config.admin.apiKey && safeEqual(key, config.admin.apiKey)) return next();
    return res.status(401).json({ error: 'Invalid admin key' });
  }

  if (!config.admin.apiKey && !config.admin.password) {
    return res.status(503).json({ error: 'Admin access is not configured.' });
  }
  return res.status(401).json({ error: 'Admin authentication required' });
}
