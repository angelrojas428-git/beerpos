import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const query = jest.fn();
const pool = { connect: jest.fn() };
jest.unstable_mockModule('../src/db/pool.js', () => ({ pool, query }));

// Mock session.js so requireStaffSession resolves test tokens from global.__beerposSessions.
jest.unstable_mockModule('../src/lib/session.js', () => ({
  getStaffSession: (token) => {
    const store = globalThis.__beerposSessions || {};
    const s = token ? store[token] : null;
    if (!s) return null;
    if (s.expiresAt && s.expiresAt < Date.now()) return null;
    return s;
  },
  createSession: (staff, establishment_id) => ({ staff, establishment_id, expiresAt: Date.now() + 3600000 }),
  deleteSession: () => {},
}));

const { default: authRouter } = await import('../src/routes/auth.js');
const { validatePin, hashPin } = await import('../src/lib/pin.js');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

function setStaffSession({ id = 1, role = 'owner', establishment_id = 1 } = {}) {
  globalThis.__beerposSessions = {
    valid: { staff: { id, role, pin: 'hashed' }, establishment_id, expiresAt: Date.now() + 3600000 },
  };
}

describe('PIN policy (validatePin)', () => {
  test('accepts 6+ digit numeric PINs', () => {
    expect(validatePin('123456').ok).toBe(true);
    expect(validatePin('000000').ok).toBe(true);
  });

  test('rejects non-numeric and too-short PINs', () => {
    expect(validatePin('12345').ok).toBe(false);     // 5 digits
    expect(validatePin('12a456').ok).toBe(false);    // non-numeric
    expect(validatePin('').ok).toBe(false);          // empty
    expect(validatePin('1234567890123').ok).toBe(false); // > 12 digits
  });
});

describe('POST /api/auth/change-pin', () => {
  beforeEach(() => {
    query.mockReset();
    delete globalThis.__beerposSessions;
  });

  test('rejects a new PIN that violates the policy (400)', async () => {
    setStaffSession();
    const response = await request(app)
      .post('/api/auth/change-pin')
      .set('x-session-token', 'valid')
      .send({ new_pin: '12345' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/6 dígitos/);
    expect(query).not.toHaveBeenCalled();
  });

  test('requires authentication (401 without token)', async () => {
    const response = await request(app)
      .post('/api/auth/change-pin')
      .send({ new_pin: '123456' });

    expect(response.status).toBe(401);
  });

  test('owner changes another staff PIN in the same establishment', async () => {
    setStaffSession({ id: 1, role: 'owner' });
    query
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'Ana' }], rowCount: 1 }) // target staff lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                       // update

    const response = await request(app)
      .post('/api/auth/change-pin')
      .set('x-session-token', 'valid')
      .send({ staff_id: 5, new_pin: '654321' });

    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE staff SET pin'),
      expect.any(Array)
    );
  });
});

describe('Account lockout', () => {
  test('locks the account after repeated failed logins and clears on success', async () => {
    const { recordFailure, recordSuccess, isLocked } = await import('../src/lib/lockout.js');
    const est = 12345;
    const name = 'LockTest';
    recordSuccess(est, name); // ensure clean slate
    for (let i = 0; i < 5; i++) recordFailure(est, name);
    expect(isLocked(est, name).locked).toBe(true);
    recordSuccess(est, name);
    expect(isLocked(est, name).locked).toBe(false);
  });
});

describe('POST /api/auth/login (platform_admin)', () => {
  beforeEach(() => {
    query.mockReset();
    delete globalThis.__beerposSessions;
    globalThis.__beerposTotpChallenges = {};
  });

  test('logs in a platform admin without establishment_id (establishment_id null in session)', async () => {
    const pin = '123456';
    const hash = await hashPin(pin);
    query.mockResolvedValueOnce({ rows: [{ id: 99, name: 'platform', role: 'platform_admin', establishment_id: null, pin: hash, active: true }], rowCount: 1 });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ establishment_id: 0, name: 'platform', pin });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.staff.role).toBe('platform_admin');
    expect(res.body.staff.establishment_id).toBeNull();
    // Lookup must target platform admins (NULL establishment).
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("role = 'platform_admin'"),
      expect.any(Array)
    );
  });

  test('rejects wrong PIN for a platform admin (401)', async () => {
    const hash = await hashPin('123456');
    query.mockResolvedValueOnce({ rows: [{ id: 99, name: 'platform', role: 'platform_admin', establishment_id: null, pin: hash, active: true }], rowCount: 1 });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ establishment_id: 0, name: 'platform', pin: '000000' });

    expect(res.status).toBe(401);
  });

  test('a non-platform staff row is not accepted for a platform login (401)', async () => {
    // A regular owner row exists, but the platform login query filters establishment_id IS NULL
    // AND role = 'platform_admin'; mock returns no row.
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ establishment_id: 0, name: 'Admin', pin: '1234' });

    expect(res.status).toBe(401);
  });

  test('normal staff login still requires establishment_id (regression)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ name: 'Admin', pin: '1234' });

    expect(res.status).toBe(400);
  });

  test('rejects a non-numeric establishment_id with 400 (not 500)', async () => {
    query.mockReset();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ establishment_id: 'abc', name: 'Admin', pin: '1234' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/establishment_id/i);
    expect(query).not.toHaveBeenCalled();
  });

  test('rejects a non-positive establishment_id with 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ establishment_id: -1, name: 'Admin', pin: '1234' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth (create establishment) authorization', () => {
  beforeEach(() => {
    query.mockReset();
    delete globalThis.__beerposSessions;
  });

  test('forbids an owner from creating an establishment (403)', async () => {
    setStaffSession({ id: 1, role: 'owner', establishment_id: 1 });

    const res = await request(app)
      .post('/api/auth')
      .set('x-session-token', 'valid')
      .send({ name: 'New Shop', owner_name: 'Bob' });

    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  test('requires a session at all (401)', async () => {
    const res = await request(app)
      .post('/api/auth')
      .send({ name: 'New Shop', owner_name: 'Bob' });

    expect(res.status).toBe(401);
  });
});