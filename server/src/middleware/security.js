import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

// Sets a strong set of secure HTTP headers (HSTS, no-sniff, frameguard, etc.).
export const helmetMiddleware = helmet();

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

// Much tighter limit on auth endpoints — slows credential-stuffing / token abuse.
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please slow down.' },
});
