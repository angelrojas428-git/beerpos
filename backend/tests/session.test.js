import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// Isolate the file backend: a temp SESSION_FILE and no REDIS_URL.
// jest is configured with clearMocks but not resetModules, so we reset the
// session module registry per test to re-read env (module-level `useRedis`).
let tmpDir;
let sessionFile;

function sessionFilePath() {
  return sessionFile || join(tmpDir, 'nested', 'sessions.json');
}

async function loadSessionModule() {
  delete process.env.REDIS_URL;
  process.env.SESSION_FILE = sessionFilePath();
  jest.resetModules();
  return import('../src/lib/session.js');
}

function seedSessionFile(entries) {
  const file = sessionFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(entries), 'utf8');
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'beerpos-sessions-'));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete process.env.SESSION_FILE;
  delete process.env.REDIS_URL;
});

describe('session store (file backend)', () => {
  test('create -> get round-trips the session', async () => {
    const mod = await loadSessionModule();
    const staff = { id: 7, name: 'Ana', role: 'owner' };
    const created = await mod.createSession(staff, 1);

    expect(created.sessionToken).toMatch(/^[0-9a-f]{48}$/);
    expect(created.establishment_id).toBe(1);
    expect(created.expiresAt).toBeGreaterThan(Date.now());

    const fetched = await mod.getStaffSession(created.sessionToken);
    expect(fetched).not.toBeNull();
    expect(fetched.sessionToken).toBe(created.sessionToken);
    expect(fetched.staff).toEqual(staff);
    expect(fetched.establishment_id).toBe(1);
  });

  test('getStaffSession returns null for unknown/empty token', async () => {
    const mod = await loadSessionModule();
    expect(await mod.getStaffSession('does-not-exist')).toBeNull();
    expect(await mod.getStaffSession(undefined)).toBeNull();
    expect(await mod.getStaffSession('')).toBeNull();
  });

  test('deleteSession removes the session', async () => {
    const mod = await loadSessionModule();
    const created = await mod.createSession({ id: 1, name: 'X', role: 'cashier' }, 2);
    expect(await mod.getStaffSession(created.sessionToken)).not.toBeNull();

    await mod.deleteSession(created.sessionToken);
    expect(await mod.getStaffSession(created.sessionToken)).toBeNull();
  });

  test('deleteSession on unknown token is a no-op (no throw)', async () => {
    const mod = await loadSessionModule();
    await expect(mod.deleteSession('nope')).resolves.toBeUndefined();
  });

  test('expired session is rejected and purged from disk', async () => {
    const token = 'a'.repeat(48);
    seedSessionFile({
      [token]: { sessionToken: token, staff: { id: 3, name: 'C', role: 'cashier' }, establishment_id: 1, expiresAt: Date.now() - 1000 },
    });

    const mod = await loadSessionModule();
    expect(await mod.getStaffSession(token)).toBeNull();

    // Purged from the in-memory store and persisted back to disk.
    const { readFileSync, existsSync } = await import('node:fs');
    if (existsSync(sessionFilePath())) {
      const onDisk = JSON.parse(readFileSync(sessionFilePath(), 'utf8'));
      expect(onDisk[token]).toBeUndefined();
    }
  });

  test('valid seeded session is returned', async () => {
    const token = 'b'.repeat(48);
    const staff = { id: 4, name: 'D', role: 'owner' };
    seedSessionFile({
      [token]: { sessionToken: token, staff, establishment_id: 5, expiresAt: Date.now() + 60_000 },
    });

    const mod = await loadSessionModule();
    const fetched = await mod.getStaffSession(token);
    expect(fetched).not.toBeNull();
    expect(fetched.staff).toEqual(staff);
    expect(fetched.establishment_id).toBe(5);
  });

  test('deleteSessionsByEstablishment removes only that establishment\'s sessions', async () => {
    const mod = await loadSessionModule();
    const a1 = await mod.createSession({ id: 1, name: 'A', role: 'owner' }, 1);
    const a2 = await mod.createSession({ id: 2, name: 'B', role: 'cashier' }, 1);
    const b1 = await mod.createSession({ id: 3, name: 'C', role: 'owner' }, 2);

    const removed = await mod.deleteSessionsByEstablishment(1);
    expect(removed).toBe(2);
    expect(await mod.getStaffSession(a1.sessionToken)).toBeNull();
    expect(await mod.getStaffSession(a2.sessionToken)).toBeNull();
    expect(await mod.getStaffSession(b1.sessionToken)).not.toBeNull();
  });

  test('deleteSessionsByEstablishment returns 0 for unknown establishment', async () => {
    const mod = await loadSessionModule();
    await mod.createSession({ id: 1, name: 'A', role: 'owner' }, 1);
    expect(await mod.deleteSessionsByEstablishment(999)).toBe(0);
    expect(await mod.deleteSessionsByEstablishment(null)).toBe(0);
  });
});