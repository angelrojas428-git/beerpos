import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

// Minimum PIN policy applied when CREATING/CHANGING a PIN.
// Legacy 4-digit PINs (e.g. the demo) keep working for login; only new PINs are validated.
export const PIN_MIN_LENGTH = 6;

/**
 * Validate a plaintext PIN against the policy (numeric, min length).
 * @returns {{ ok: boolean, error?: string }}
 */
export function validatePin(plainPin) {
  const pin = String(plainPin ?? '');
  if (!/^\d+$/.test(pin)) {
    return { ok: false, error: 'El PIN debe contener solo dígitos.' };
  }
  if (pin.length < PIN_MIN_LENGTH) {
    return { ok: false, error: `El PIN debe tener al menos ${PIN_MIN_LENGTH} dígitos.` };
  }
  if (pin.length > 12) {
    return { ok: false, error: 'El PIN no puede superar 12 dígitos.' };
  }
  return { ok: true };
}

/**
 * Hash a plaintext PIN for storage.
 */
export async function hashPin(plainPin) {
  return bcrypt.hash(String(plainPin), SALT_ROUNDS);
}

/**
 * Verify a plaintext PIN against a stored hash.
 * Supports legacy plaintext PINs (auto-migrates on successful login).
 */
export async function verifyPin(plainPin, storedValue) {
  if (!storedValue) return false;
  const pin = String(plainPin);
  // bcrypt hashes start with $2a$, $2b$, or $2y$
  if (/^\$2[aby]\$/.test(storedValue)) {
    return bcrypt.compare(pin, storedValue);
  }
  // Legacy plaintext comparison (will be migrated by caller)
  return pin === storedValue;
}

/**
 * Check if a stored PIN value is a bcrypt hash (needs migration) or plaintext.
 */
export function isLegacyPin(storedValue) {
  if (!storedValue) return false;
  return !/^\$2[aby]\$/.test(storedValue);
}