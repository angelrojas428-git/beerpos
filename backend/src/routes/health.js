import { Router } from 'express';
import { query } from '../db/pool.js';
import { getIO } from '../lib/socket.js';
import { requireStaffSession } from '../middleware/auth.js';

const router = Router();

// Public liveness probe for the platform (Render/Caddy/uptime monitors).
// Unauthenticated and minimal: only reports whether the process and DB respond.
// Returns 200 when DB answers SELECT 1 within 3s, 503 otherwise.
router.get('/live', async (_req, res) => {
  const start = Date.now();
  try {
    await Promise.race([
      query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout')), 3000)),
    ]);
    res.status(200).json({ ok: true, db: 'up', uptime_s: Math.round(process.uptime()), response_ms: Date.now() - start });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down', error: e.message, response_ms: Date.now() - start });
  }
});

// Detailed health check: DB connection, memory, uptime, socket connections, sessions
// Protected: staff session required
router.get('/', requireStaffSession, async (req, res, next) => {
  const start = Date.now();
  const health = {
    ok: true,
    service: 'beerpos-backend',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    node: process.version,
    platform: process.platform,
    memory: {
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100,
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
      heap_total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024 * 100) / 100,
      external_mb: Math.round(process.memoryUsage().external / 1024 / 1024 * 100) / 100,
    },
    db: 'unknown',
    socket: 'unknown',
    sessions: 'unknown',
  };
  try {
    const dbStart = Date.now();
    await query('SELECT 1');
    health.db = {
      ok: true,
      latency_ms: Date.now() - dbStart
    };

    // Count rows in key tables for DB health detail (in parallel).
    const tables = ['establishments', 'staff', 'clients', 'transactions', 'fast_redemptions', 'client_orders', 'audit_log'];
    const tableCounts = {};
    await Promise.all(tables.map(async (table) => {
      try {
        const { rows } = await query(`SELECT COUNT(*) as cnt FROM ${table}`);
        tableCounts[table] = parseInt(rows[0].cnt, 10);
      } catch (e) {
        tableCounts[table] = `error: ${e.message}`;
      }
    }));
    health.db.tables = tableCounts;
  } catch (e) {
    health.ok = false;
    health.db = { ok: false, error: e.message };
  }

  // Socket.IO health
  try {
    const io = getIO();
    if (io) {
      const sockets = io.sockets.sockets.values();
      let staffCount = 0;
      let clientCount = 0;
      for (const s of sockets) {
        if (s.data.type === 'staff') staffCount++;
        if (s.data.type === 'client') clientCount++;
      }
      health.socket = {
        ok: true,
        connections: io.engine.clientsCount || 0,
        staff: staffCount,
        client: clientCount,
      };
    } else {
      health.socket = { ok: false, error: 'Socket.IO not initialized' };
    }
  } catch (e) {
    health.socket = { ok: false, error: e.message };
  }

  // Staff sessions health
  try {
    const backend = process.env.REDIS_URL ? 'redis' : 'file';
    health.sessions = { ok: true, backend, note: backend === 'redis' ? 'Sessions in Redis' : 'Sessions in data/sessions.json' };
  } catch (e) {
    health.sessions = { ok: false, error: e.message };
  }

  health.response_ms = Date.now() - start;
  res.status(health.ok ? 200 : 503).json(health);
});

export default router;