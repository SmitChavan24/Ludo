import crypto from 'node:crypto';
import { config } from '../config.js';

// Timing-safe key comparison so the admin key can't be guessed via response timing.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Guards the admin/CRM endpoints. The caller (your CRM backend, server-to-server)
// must send the shared secret in the `x-admin-key` header. If no key is
// configured the whole admin surface is disabled.
export function requireAdmin(req, res, next) {
  if (!config.adminApiKey) {
    return res.status(503).json({ error: 'Admin API is not configured (set ADMIN_API_KEY).' });
  }
  if (!safeEqual(req.headers['x-admin-key'], config.adminApiKey)) {
    return res.status(401).json({ error: 'Invalid admin key' });
  }
  next();
}
