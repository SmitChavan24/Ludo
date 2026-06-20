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
export function issueRefreshToken(user) {
  const jti = nanoid(24);
  const token = jwt.sign({}, config.jwt.refreshSecret, {
    subject: user.id,
    jwtid: jti,
    expiresIn: config.jwt.refreshTtl,
  });
  store.saveRefreshSession(jti, user.id, Date.now() + config.jwt.refreshTtl * 1000);
  return token;
}

export function verifyRefreshToken(token) {
  const payload = jwt.verify(token, config.jwt.refreshSecret);
  if (!store.getRefreshSession(payload.jti)) {
    throw new Error('Refresh session revoked');
  }
  return payload;
}

// Rotate: revoke the old jti and mint a fresh refresh token.
export function rotateRefreshToken(oldPayload, user) {
  store.revokeRefreshSession(oldPayload.jti);
  return issueRefreshToken(user);
}

export function revokeRefreshToken(payload) {
  if (payload?.jti) store.revokeRefreshSession(payload.jti);
}
