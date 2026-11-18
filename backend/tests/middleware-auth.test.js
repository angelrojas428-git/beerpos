import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This file exercises the async requireStaffSession middleware against the
// file session backend. Jest isolates each test file in its own module
// registry, so a single dynamic import in beforeAll is enough and avoids the
// flakiness of repeated jest.resetModules() + dynamic import of ESM.
let tmpDir;
let sessionMod;
let requireStaffSession;

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'beerpos-mw-'));
  delete process.env.REDIS_URL;
  process.env.SESSION_FILE = join(tmpDir, 'sessions.json');

  sessionMod = await import('../src/lib/session.js');
  ({ requireStaffSession } = await import('../src/middleware/auth.js'));
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete process.env.SESSION_FILE;
  delete process.env.REDIS_URL;
});

describe('requireStaffSession middleware (async)', () => {
  test('attaches staff/establishment and calls next() for a valid token', async () => {
    const created = await sessionMod.createSession({ id: 9, name: 'Z', role: 'owner' }, 3);

    const req = { headers: { 'x-session-token': created.sessionToken } };
    const res = fakeRes();
    let nextArg = 'NOT_CALLED';
    await requireStaffSession(req, res, (err) => { nextArg = err; });

    expect(nextArg).toBeUndefined();
    expect(req.staff).toEqual({ id: 9, name: 'Z', role: 'owner' });
    expect(req.establishmentId).toBe(3);
    expect(res.statusCode).toBe(200);
  });

  test('returns 401 when the token header is missing', async () => {
    const req = { headers: {} };
    const res = fakeRes();
    let nextArg = 'NOT_CALLED';
    await requireStaffSession(req, res, (err) => { nextArg = err; });

    expect(nextArg).toBe('NOT_CALLED');
    expect(res.statusCode).toBe(401);
  });

  test('returns 401 for an unknown token', async () => {
    const req = { headers: { 'x-session-token': 'f'.repeat(48) } };
    const res = fakeRes();
    let nextArg = 'NOT_CALLED';
    await requireStaffSession(req, res, (err) => { nextArg = err; });

    expect(nextArg).toBe('NOT_CALLED');
    expect(res.statusCode).toBe(401);
  });
});