import { describe, expect, test } from '@jest/globals';
import { generateAccessToken, hashAccessToken, isHashedToken } from '../src/lib/token.js';

describe('access token hashing', () => {
  test('generateAccessToken returns a 48-char hex plaintext token', () => {
    const t = generateAccessToken();
    expect(t).toMatch(/^[a-f0-9]{48}$/);
  });

  test('hashAccessToken is deterministic sha256 (64 hex) and differs from plaintext', () => {
    const t = generateAccessToken();
    const h1 = hashAccessToken(t);
    const h2 = hashAccessToken(t);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
    expect(h1).not.toBe(t);
  });

  test('different tokens produce different hashes', () => {
    expect(hashAccessToken('token-a')).not.toBe(hashAccessToken('token-b'));
  });

  test('isHashedToken distinguishes hashes from plaintext', () => {
    expect(isHashedToken(hashAccessToken('x'))).toBe(true);
    expect(isHashedToken(generateAccessToken())).toBe(false);
    expect(isHashedToken('')).toBe(false);
    expect(isHashedToken(null)).toBe(false);
  });
});