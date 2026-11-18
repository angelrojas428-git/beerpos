import crypto from 'crypto';

/**
 * Generate a new plaintext access token for a client (returned once, stored hashed).
 * 24 random bytes → 48 hex chars.
 */
export function generateAccessToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Hash a plaintext access token for storage/lookup (sha256 hex, 64 chars).
 * Tokens are stored hashed at rest so a database leak does not expose usable tokens.
 * Lookups hash the presented token and compare against the stored hash.
 */
export function hashAccessToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** True if a stored value looks like a sha256 hex digest (already hashed). */
export function isHashedToken(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}