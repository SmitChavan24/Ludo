import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { store } from '../db/store.js';

// Short-lived access token: carries identity, used on every request/socket.
export function signAccessToken(user) {
  return jwt.sign({ name: user.name, picture: user.picture }, config.jwt.accessSecret, {
    subject: user.id,
    expiresIn: config.jwt.accessTtl,
  });
}

// Throws if the token is missing, tampered, or expired.
export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.accessSecret);
}

// Long-lived refresh token, tracked by jti so it can be revoked (logout) and
// rotated (one-time use) — a stolen refresh token is far less dangerous this way.
export async function issueRefreshToken(user) {
  const jti = nanoid(24);
  const token = jwt.sign({}, config.jwt.refreshSecret, {
    subject: user.id,
    jwtid: jti,
    expiresIn: config.jwt.refreshTtl,
  });
  await store.saveRefreshSession(jti, user.id, Date.now() + config.jwt.refreshTtl * 1000);
  return token;
}

export async function verifyRefreshToken(token) {
  const payload = jwt.verify(token, config.jwt.refreshSecret);
  if (!(await store.getRefreshSession(payload.jti))) {
    throw new Error('Refresh session revoked');
  }
  return payload;
}

// Rotate: revoke the old jti and mint a fresh refresh token.
export async function rotateRefreshToken(oldPayload, user) {
  await store.revokeRefreshSession(oldPayload.jti);
  return issueRefreshToken(user);
}

export async function revokeRefreshToken(payload) {
  if (payload?.jti) await store.revokeRefreshSession(payload.jti);
}

// ── Admin web-page session tokens ──
// A separate `scope: 'admin'` claim means a normal player token can never be
// used to reach an admin endpoint, even though both are signed with the same key.
export function signAdminToken(username) {
  return jwt.sign({ scope: 'admin' }, config.jwt.accessSecret, {
    subject: `admin:${username}`,
    expiresIn: config.admin.jwtTtl,
  });
}

export function verifyAdminToken(token) {
  const payload = jwt.verify(token, config.jwt.accessSecret);
  if (payload.scope !== 'admin') throw new Error('Not an admin token');
  return payload;
}
