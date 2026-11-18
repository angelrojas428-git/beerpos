// Persistent staff session store.
//
// Backend selection:
//  - If REDIS_URL is set -> Redis (shared across instances, survives restarts).
//  - Otherwise           -> local file (single instance, survives restarts).
//
// All functions are async so the same call sites work with either backend.
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from './config.js';

const SESSION_PREFIX = 'beerpos:session:';
const useRedis = Boolean(process.env.REDIS_URL);

// --- Redis backend (lazy connection) ---
let redisClient = null;
let redisPromise = null;
async function getRedis() {
  if (!useRedis) return null;
  if (redisClient) return redisClient;
  if (!redisPromise) {
    redisPromise = (async () => {
      const { createClient } = await import('redis');
      const client = createClient({ url: process.env.REDIS_URL });
      client.on('error', (e) => console.error('Redis error:', e.message));
      await client.connect();
      redisClient = client;
      return client;
    })().catch((e) => {
      redisPromise = null;
      throw e;
    });
  }
  return redisPromise;
}

// --- File backend (fallback) ---
const SESSIONS_FILE = process.env.SESSION_FILE || join(process.cwd(), 'data', 'sessions.json');

function loadSessions() {
  if (!existsSync(SESSIONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  try {
    const dir = dirname(SESSIONS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions), 'utf8');
  } catch (e) {
    console.warn('No se pudieron persistir las sesiones:', e.message);
  }
}

let fileSessions = loadSessions();

// Periodic cleanup of expired file sessions (Redis uses TTL, no sweep needed).
if (!useRedis) {
  const cleanup = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [token, s] of Object.entries(fileSessions)) {
      if (s.expiresAt < now) {
        delete fileSessions[token];
        changed = true;
      }
    }
    if (changed) saveSessions(fileSessions);
  }, 60000);
  // Do not keep the process alive just for the cleanup timer.
  if (typeof cleanup.unref === 'function') cleanup.unref();
}

function newSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Create a session for a staff member. Returns the session (including sessionToken).
 */
export async function createSession(staff, establishment_id) {
  const sessionToken = newSessionToken();
  const session = {
    sessionToken,
    staff,
    establishment_id,
    expiresAt: Date.now() + config.sessionTtlMs,
  };

  const client = await getRedis();
  if (client) {
    const ttlSeconds = Math.max(1, Math.floor(config.sessionTtlMs / 1000));
    await client.set(SESSION_PREFIX + sessionToken, JSON.stringify(session), { EX: ttlSeconds });
  } else {
    fileSessions[sessionToken] = session;
    saveSessions(fileSessions);
  }
  return session;
}

/**
 * Resolve a session token to its session, or null if missing/expired.
 */
export async function getStaffSession(sessionToken) {
  if (!sessionToken) return null;

  const client = await getRedis();
  if (client) {
    const raw = await client.get(SESSION_PREFIX + sessionToken);
    if (!raw) return null;
    let session;
    try {
      session = JSON.parse(raw);
    } catch {
      return null;
    }
    if (session.expiresAt < Date.now()) {
      await client.del(SESSION_PREFIX + sessionToken);
      return null;
    }
    return session;
  }

  const session = fileSessions[sessionToken];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    delete fileSessions[sessionToken];
    saveSessions(fileSessions);
    return null;
  }
  return session;
}

/**
 * Delete a session token.
 */
export async function deleteSession(sessionToken) {
  if (!sessionToken) return;

  const client = await getRedis();
  if (client) {
    await client.del(SESSION_PREFIX + sessionToken);
    return;
  }
  if (fileSessions[sessionToken]) {
    delete fileSessions[sessionToken];
    saveSessions(fileSessions);
  }
}

/**
 * Close the Redis connection (used during graceful shutdown).
 */
export async function closeRedis() {
  if (redisClient) {
    try { await redisClient.quit(); } catch { /* ignore */ }
    redisClient = null;
    redisPromise = null;
  }
}

/**
 * Delete every session belonging to an establishment (force logout).
 * Used by the platform admin "force logout" support action.
 * @returns {Promise<number>} number of sessions removed.
 */
export async function deleteSessionsByEstablishment(establishmentId) {
  if (establishmentId === null || establishmentId === undefined) return 0;
  const target = Number(establishmentId);

  const client = await getRedis();
  if (client) {
    const keys = await client.keys(SESSION_PREFIX + '*');
    if (!keys.length) return 0;
    const values = await client.mGet(keys);
    const toDelete = [];
    for (let i = 0; i < keys.length; i++) {
      const raw = values[i];
      if (!raw) continue;
      try {
        const session = JSON.parse(raw);
        if (Number(session.establishment_id) === target) toDelete.push(keys[i]);
      } catch {
        /* skip corrupt entries */
      }
    }
    if (toDelete.length) await client.del(toDelete);
    return toDelete.length;
  }

  let removed = 0;
  for (const [token, session] of Object.entries(fileSessions)) {
    if (Number(session.establishment_id) === target) {
      delete fileSessions[token];
      removed += 1;
    }
  }
  if (removed) saveSessions(fileSessions);
  return removed;
}