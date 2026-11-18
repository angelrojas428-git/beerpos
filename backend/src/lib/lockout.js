// In-memory account lockout for staff logins.
// Tracks failed attempts per (establishment_id, staff name) and locks the account
// temporarily after too many failures. Complements the per-IP authLimiter.
//
// NOTE: Single-instance, in-memory. For multi-instance production, move this to Redis
// (see PLAN_LANZAMIENTO.md, Fase 1). The interface is intentionally small to ease that swap.

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // count failures within 15 minutes
const LOCK_MS = 15 * 60 * 1000;   // lock for 15 minutes

const attempts = new Map(); // key -> { count, firstAt, lockedUntil }

function keyFor(establishmentId, name) {
  return `${establishmentId}:${String(name || '').trim().toLowerCase()}`;
}

// Opportunistic cleanup so the map does not grow unbounded.
function cleanupIfNeeded() {
  if (attempts.size < 10000) return;
  const now = Date.now();
  for (const [k, e] of attempts.entries()) {
    if ((e.lockedUntil && e.lockedUntil <= now) || now - e.firstAt > WINDOW_MS * 2) {
      attempts.delete(k);
    }
  }
}

/**
 * Check whether an account is currently locked.
 * @returns {{ locked: boolean, retryAfterMs?: number }}
 */
export function isLocked(establishmentId, name) {
  cleanupIfNeeded();
  const e = attempts.get(keyFor(establishmentId, name));
  if (!e) return { locked: false };
  if (e.lockedUntil && e.lockedUntil > Date.now()) {
    return { locked: true, retryAfterMs: e.lockedUntil - Date.now() };
  }
  return { locked: false };
}

/**
 * Record a failed login attempt. Returns lock state after recording.
 * @returns {{ locked: boolean, retryAfterMs?: number, attempts: number }}
 */
export function recordFailure(establishmentId, name) {
  cleanupIfNeeded();
  const k = keyFor(establishmentId, name);
  const now = Date.now();
  let e = attempts.get(k);
  if (!e || now - e.firstAt > WINDOW_MS) {
    e = { count: 0, firstAt: now, lockedUntil: 0 };
  }
  e.count += 1;
  if (e.count >= MAX_ATTEMPTS) {
    e.lockedUntil = now + LOCK_MS;
  }
  attempts.set(k, e);
  return {
    locked: e.lockedUntil > now,
    retryAfterMs: Math.max(0, e.lockedUntil - now),
    attempts: e.count,
  };
}

/** Clear the failure counter after a successful login. */
export function recordSuccess(establishmentId, name) {
  attempts.delete(keyFor(establishmentId, name));
}

export const lockoutConfig = { MAX_ATTEMPTS, WINDOW_MS, LOCK_MS };