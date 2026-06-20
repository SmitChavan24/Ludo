import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';

// One verified client for the configured OAuth audience.
const client = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

// Verify a Google ID token sent by the browser after Google Sign-In.
// google-auth-library checks the signature, issuer, audience and expiry — we
// never trust client-provided identity, only a Google-signed token.
export async function verifyGoogleIdToken(idToken) {
  if (!client) {
    throw new Error('Google login is not configured (set GOOGLE_CLIENT_ID).');
  }
  const ticket = await client.verifyIdToken({
    idToken,
    audience: config.googleClientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub) throw new Error('Invalid Google token');
  return {
    providerId: payload.sub,
    email: payload.email || null,
    name: payload.name || payload.email || 'Player',
    picture: payload.picture || null,
    emailVerified: !!payload.email_verified,
  };
}
