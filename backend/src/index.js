import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { clientLimiter } from './middleware/rateLimit.js';
import { requireStaffSession, requireOwnerRole } from './middleware/auth.js';
import { config } from './lib/config.js';
import { cspDirectives } from './lib/csp.js';
import { hashAccessToken } from './lib/token.js';

import establishmentsRouter from './routes/establishments.js';
import clientsRouter from './routes/clients.js';
import clientOrdersRouter from './routes/client_orders.js';
import transactionsRouter from './routes/transactions.js';
import redemptionsRouter from './routes/redemptions.js';
import eventsRouter from './routes/events.js';
import authRouter from './routes/auth.js';
import healthRouter from './routes/health.js';
import clientFingerprintsRouter from './routes/client-fingerprints.js';
import platformRouter from './routes/platform.js';
import creditRouter from './routes/credit.js';
import inventoryRouter from './routes/inventory.js';
import cashRouter from './routes/cash.js';
import staffRouter from './routes/staff.js';
import auditRouter from './routes/audit.js';
import helpRouter from './routes/help.js';
import { startFastSaleExpiryCron, startBackupCron, startSubscriptionCron } from './lib/cron.js';
import { setIO } from './lib/socket.js';
import { getStaffSession, closeRedis } from './lib/session.js';
import { pool, query } from './db/pool.js';
import { bootstrap } from './db/bootstrap.js';
import { runBackup, listBackups, removeBackup } from './lib/backup.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// Helmet: enforce a content security policy in production only. In development the
// app is served through BrowserSync (:3000) while Socket.io/API live on :3001, so a
// strict connect-src would break real-time locally. Production runs same-origin.
const helmetOptions = { crossOriginEmbedderPolicy: false };
if (config.isProd) {
  helmetOptions.contentSecurityPolicy = { useDefaults: false, directives: cspDirectives };
} else {
  helmetOptions.contentSecurityPolicy = false;
}
app.use(helmet(helmetOptions));
// Trust reverse proxies (Caddy/Nginx) so req.ip and rate limiting resolve the real client IP.
// Set TRUST_PROXY to the number of proxies in production (e.g. 1).
if (config.trustProxy > 0) {
  app.set('trust proxy', config.trustProxy);
}
app.use(cors({ origin: config.corsOrigin }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// API routes
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/establishments', clientLimiter, establishmentsRouter);
app.use('/api/clients', clientLimiter, clientsRouter);
app.use('/api/client-orders', clientOrdersRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/redemptions', redemptionsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/client-fingerprints', clientLimiter, clientFingerprintsRouter);
app.use('/api/platform', platformRouter);
app.use('/api/credit', creditRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/cash', cashRouter);
app.use('/api/staff', staffRouter);
app.use('/api/audit', auditRouter);
app.use('/api/help', helpRouter);

// Serve frontend (static) for simple PWA deployment
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDir = path.resolve(__dirname, '../../frontend');

// Serve uploaded logos
const uploadsDir = path.resolve(__dirname, '../uploads');
app.use('/uploads', express.static(uploadsDir));

app.use(express.static(frontendDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const message = isProd ? 'Internal Server Error' : (err.message || 'Internal Server Error');
  res.status(err.status || 500).json({ error: message });
});

const server = createServer(app);

const io = new Server(server, {
  cors: { origin: config.corsOrigin, methods: ['GET', 'POST'] },
  pingTimeout: 20000,
});
setIO(io);

io.use(async (socket, next) => {
  const sessionToken = socket.handshake.auth?.sessionToken;
  const clientToken = socket.handshake.auth?.clientToken;

  if (sessionToken) {
    const session = await getStaffSession(sessionToken);
    if (!session) return next(new Error('Unauthorized'));
    socket.data.sessionToken = sessionToken;
    socket.data.establishmentId = session.establishment_id;
    socket.data.type = 'staff';
    socket.data.expiresAt = session.expiresAt;
    return next();
  }

  if (clientToken) {
    const { rows } = await query(
      `SELECT c.id, c.establishment_id, c.access_token
       FROM clients c
       WHERE c.access_token = $1 AND (c.token_expires_at IS NULL OR c.token_expires_at > NOW())`,
      [hashAccessToken(clientToken)]
    );
    if (!rows[0]) return next(new Error('Client token invalid or expired'));
    const client = rows[0];
    socket.data.clientToken = clientToken;
    socket.data.clientId = client.id;
    socket.data.establishmentId = client.establishment_id;
    socket.data.type = 'client';
    return next();
  }

  return next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
  const establishmentId = socket.data.establishmentId;
  let expiryTimer = null;
  if (socket.data.type === 'staff' && socket.data.expiresAt) {
    expiryTimer = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, socket.data.expiresAt - Date.now())
    );
  }
  socket.join(`est:${establishmentId}`);
  console.log('socket connected', socket.id, 'type', socket.data.type, 'establishment', establishmentId);
  socket.on('disconnect', () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    console.log('socket disconnected', socket.id);
  });
});

// Backup API routes (protected: owner role only)
app.post('/api/backup', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const result = await runBackup();
    res.json({ ok: true, backup: result });
  } catch (e) { next(e); }
});

app.get('/api/backup', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const backups = listBackups();
    res.json({ ok: true, backups });
  } catch (e) { next(e); }
});

app.delete('/api/backup/:timestamp', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const removed = removeBackup(req.params.timestamp);
    res.json({ ok: true, removed });
  } catch (e) { next(e); }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`BeerPOS API listening on 0.0.0.0:${port}`);
});

// Optional auto-bootstrap (schema + platform admin) for hosts without shell access.
// Gated by DB_AUTOINIT / BOOTSTRAP_ADMIN_* env vars; no-op otherwise.
bootstrap().catch((e) => console.error('bootstrap error:', e.message));

// Start cron for fast sale expiration
startFastSaleExpiryCron();

// Start daily backup cron
startBackupCron();

// Start billing auto-suspension cron (non-payment)
startSubscriptionCron();

// Graceful shutdown: stop accepting connections, drain, close DB/Redis, then exit.
// Critical on Render/Docker so deploys don't drop in-flight requests or leak DB connections.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received: shutting down gracefully...`);
  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown timed out; forcing exit.');
    process.exit(1);
  }, 10000);
  if (typeof forceExit.unref === 'function') forceExit.unref();

  try { await new Promise((resolve) => server.close(resolve)); console.log('HTTP server closed.'); }
  catch (e) { console.error('server.close error:', e.message); }
  try { await pool.end(); console.log('DB pool closed.'); }
  catch (e) { console.error('pool.end error:', e.message); }
  try { await closeRedis(); } catch (e) { console.error('redis close error:', e.message); }

  clearTimeout(forceExit);
  console.log('Shutdown complete.');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;

