import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { config } from './config.js';
import { helmetMiddleware, corsMiddleware, apiLimiter, authLimiter } from './middleware/security.js';
import { router } from './http/routes.js';
import { adminRouter } from './http/adminRoutes.js';
import { GameManager } from './game/GameManager.js';
import { registerSocketHandlers } from './socket/handlers.js';
import { initStorage } from './db/initStorage.js';

const app = express();
app.disable('x-powered-by');
app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(express.json({ limit: '64kb' })); // small body cap — these are tiny JSON payloads
app.use('/api', apiLimiter, router);
app.use('/api/admin', authLimiter, adminRouter); // CRM/admin — admin JWT or x-admin-key

// Static admin web page (JWT-protected UI for coin top-ups), served at /admin.
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(publicDir));
app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));

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
  server.listen(config.port, () => {
    console.log(`♟  Ludo server listening on http://localhost:${config.port}  (${config.env})`);
    console.log(`   CORS origins: ${config.clientOrigins.join(', ')}`);
    if (config.allowDevLogin) console.log('   Dev login ENABLED (POST /api/auth/dev)');
  });
}

start().catch((err) => {
  console.error('[startup] failed to start server:', err);
  process.exit(1);
});

export { app, server, io, manager };
