import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

// Sets a strong set of secure HTTP headers (HSTS, no-sniff, frameguard, etc.).
// A Content-Security-Policy is the main defence against a script injected into
// the page (via a player name, a tournament title, anything user-supplied)
// being able to phone home or load attacker code.
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Google Identity Services needs its script + iframe.
      scriptSrc: ["'self'", 'https://accounts.google.com', 'https://apis.google.com'],
      frameSrc: ["'self'", 'https://accounts.google.com'],
      connectSrc: ["'self'", 'https://accounts.google.com', 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      mediaSrc: ["'self'", 'blob:'], // camera preview for the UPI QR scanner
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"], // nobody may iframe the game (clickjacking)
    },
  },
  crossOriginEmbedderPolicy: false, // would block Google's sign-in iframe
});

// Only our own front-end origins may call the API / open a socket.
export const corsMiddleware = cors({
  origin: config.clientOrigins,
  credentials: true,
});

// General API throttle — blunts scraping and abuse.
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Anonymous practice sessions. Generous enough that a player retrying a few
// times never sees an error, but still bounded so nobody can mint sessions in
// bulk. Kept separate from the strict credential limiter below.
export const guestLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many practice sessions from this device. Please wait a few minutes.' },
});

// Authenticated admin work is bursty — opening a tournament, approving a
// payment and refreshing the dashboard are several calls in a second. The
// brute-force protection lives on /admin/login (see adminGuard), so this only
// needs to stop runaway loops.
export const adminApiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests — slow down.' },
});

// Much tighter limit on auth endpoints — slows credential-stuffing / token abuse.
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please slow down.' },
});
