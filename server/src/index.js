import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { config } from './config.js';
import { helmetMiddleware, corsMiddleware, apiLimiter, adminApiLimiter } from './middleware/security.js';
import { router } from './http/routes.js';
import { adminRouter } from './http/adminRoutes.js';
import { GameManager } from './game/GameManager.js';
import { registerSocketHandlers } from './socket/handlers.js';
import { initStorage } from './db/initStorage.js';
import { scheduler } from './tournament/scheduler.js';
import { shop } from './shop/CoinShop.js';

const app = express();
app.disable('x-powered-by');
// Behind nginx/Cloudflare the client address arrives in X-Forwarded-For. Without
// this every request looks like it comes from the proxy, which would make
// per-IP rate limits and the admin lockout useless.
if (config.isProd) app.set('trust proxy', 1);
app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(express.json({ limit: '64kb' })); // small body cap — these are tiny JSON payloads
app.use('/api', apiLimiter, router);
app.use('/api/admin', adminApiLimiter, adminRouter); // CRM/admin — admin JWT or x-admin-key

// Static admin web page (JWT-protected UI for coin top-ups), served at /admin.
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(srcDir, '..', 'public');
// The admin console is a tiny, admin-only bundle that changes with every
// deploy. Caching it just means an operator staring at a stale panel and
// wondering why their tournament didn't appear — never worth the bytes saved.
app.use(
  express.static(publicDir, {
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    },
  }),
);
// Legal pages (static HTML, linked from the lobby, coin shop and Google consent screen).
for (const page of ['privacy', 'terms']) {
  app.get(`/${page}`, (req, res) => res.sendFile(path.join(publicDir, `${page}.html`)));
}
app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// In production, serve the built client (same origin) with an SPA fallback.
if (config.serveClient) {
  const clientDist = config.clientDist || path.join(srcDir, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/admin') || req.path.startsWith('/socket.io')) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
    console.log(`   Serving client from ${clientDist}`);
  } else {
    console.warn(`[client] SERVE_CLIENT is on but ${clientDist} does not exist (run the client build).`);
  }
}

const server = http.createServer(app);

const io = new SocketServer(server, {
  cors: { origin: config.clientOrigins, credentials: true },
});

const manager = new GameManager(io);
registerSocketHandlers(io, manager);

// Never let an unexpected error take the whole process (and everyone's game)
// down silently — log loudly so it shows up in monitoring.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

// Connect storage (MySQL or in-memory) BEFORE accepting traffic, so the very
// first request already has a working, persistent backend.
async function start() {
  await initStorage();
  // Tournaments begin (or get cancelled) on their own schedule.
  scheduler.start();
  shop.start(); // credits coin packs paid on pay.billtrack.me

  // `listen` reports failures as an 'error' EVENT, not a rejected promise, so
  // without this a bad port escapes to the uncaughtException handler as a raw
  // stack trace and the process lingers instead of exiting.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n✖ Port ${config.port} is already in use — another server is running.\n` +
          `  Free it with:  lsof -ti :${config.port} | xargs -r kill\n` +
          `  Or use a different port:  PORT=4001 npm run dev\n`,
      );
    } else {
      console.error('[startup] server error:', err);
    }
    process.exit(1);
  });

  server.listen(config.port, () => {
    console.log(`♟  Ludo server listening on http://localhost:${config.port}  (${config.env})`);
    console.log(`   Cash features: ${config.cashEnabled ? 'ON' : 'off'} · Coin shop: ${shop.enabled ? 'on' : 'off'}`);
    console.log(`   CORS origins: ${config.clientOrigins.join(', ')}`);
    if (config.allowDevLogin) console.log('   Dev login ENABLED (POST /api/auth/dev)');
  });
}

start().catch((err) => {
  console.error('[startup] failed to start server:', err);
  process.exit(1);
});

export { app, server, io, manager };
