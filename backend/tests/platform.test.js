import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const query = jest.fn();
const poolConnect = jest.fn();
jest.unstable_mockModule('../src/db/pool.js', () => ({ pool: { connect: poolConnect }, query }));

const deleteSessionsByEstablishment = jest.fn();
jest.unstable_mockModule('../src/lib/session.js', () => ({
  getStaffSession: (token) => {
    const store = globalThis.__beerposSessions || {};
    return token ? store[token] || null : null;
  },
  deleteSessionsByEstablishment,
}));

const auditLog = jest.fn();
jest.unstable_mockModule('../src/lib/audit.js', () => ({ auditLog }));

const { default: platformRouter } = await import('../src/routes/platform.js');

const app = express();
app.use(express.json());
app.use('/api/platform', platformRouter);

function setSession({ id = 99, role = 'platform_admin', establishment_id = null } = {}) {
  globalThis.__beerposSessions = {
    valid: { staff: { id, role }, establishment_id, expiresAt: Date.now() + 3600000 },
  };
}

beforeEach(() => {
  query.mockReset();
  poolConnect.mockReset();
  deleteSessionsByEstablishment.mockReset();
  auditLog.mockReset();
  delete globalThis.__beerposSessions;
});

describe('platform API auth', () => {
  test('401 without a session token', async () => {
    const res = await request(app).get('/api/platform');
    expect(res.status).toBe(401);
  });

  test('403 for a non-platform-admin (owner)', async () => {
    setSession({ id: 1, role: 'owner', establishment_id: 1 });
    const res = await request(app).get('/api/platform').set('x-session-token', 'valid');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/platform (list + metrics)', () => {
  test('returns establishments with numeric metrics', async () => {
    setSession();
    query.mockResolvedValueOnce({
      rows: [{
        id: 1, name: 'Tasca Demo', owner_name: 'Admin', active: true,
        clients_count: '5', staff_count: '2', transactions_count: '10', revenue_usd: '123.45',
      }],
    });

    const res = await request(app).get('/api/platform').set('x-session-token', 'valid');

    expect(res.status).toBe(200);
    const est = res.body.establishments[0];
    expect(est.clients_count).toBe(5);
    expect(est.staff_count).toBe(2);
    expect(est.transactions_count).toBe(10);
    expect(est.revenue_usd).toBe(123.45);
  });
});

describe('POST /api/platform (onboarding)', () => {
  function mockTxDb(estRow) {
    const dbQuery = jest.fn(async (sql) => {
      if (sql.includes('INSERT INTO establishments')) return { rows: [estRow] };
      return { rows: [], rowCount: 1 };
    });
    const db = { query: dbQuery, release: jest.fn() };
    poolConnect.mockResolvedValueOnce(db);
    return db;
  }

  test('creates establishment + owner + rate atomically and audits', async () => {
    setSession();
    const db = mockTxDb({ id: 10, name: 'Nueva Tasca', owner_name: 'Juan', active: true });

    const res = await request(app)
      .post('/api/platform')
      .set('x-session-token', 'valid')
      .send({ name: 'Nueva Tasca', owner_name: 'Juan', owner_pin: '123456', usd_to_ves: 36.5 });

    expect(res.status).toBe(201);
    expect(res.body.establishment.id).toBe(10);

    const sqls = db.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('BEGIN'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO establishments'))).toBe(true);
    expect(sqls.some((s) => s.includes("INSERT INTO staff") && s.includes("'owner'"))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO exchange_rates'))).toBe(true);
    expect(sqls.some((s) => s.includes('COMMIT'))).toBe(true);
    expect(db.release).toHaveBeenCalled();

    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_establishment_created', establishmentId: 10 }));
  });

  test('400 when name is missing', async () => {
    setSession();
    const res = await request(app)
      .post('/api/platform')
      .set('x-session-token', 'valid')
      .send({ owner_name: 'Juan', owner_pin: '123456' });
    expect(res.status).toBe(400);
    expect(poolConnect).not.toHaveBeenCalled();
  });

  test('400 when owner_pin violates policy', async () => {
    setSession();
    const res = await request(app)
      .post('/api/platform')
      .set('x-session-token', 'valid')
      .send({ name: 'Tasca', owner_name: 'Juan', owner_pin: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/6 dígitos/);
  });

  test('400 when usd_to_ves is not positive', async () => {
    setSession();
    const res = await request(app)
      .post('/api/platform')
      .set('x-session-token', 'valid')
      .send({ name: 'Tasca', owner_name: 'Juan', owner_pin: '123456', usd_to_ves: -1 });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/platform/:id (edit / suspend)', () => {
  test('suspends an establishment (active=false honored)', async () => {
    setSession();
    query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Tasca', active: false }] });

    const res = await request(app)
      .patch('/api/platform/1')
      .set('x-session-token', 'valid')
      .send({ active: false });

    expect(res.status).toBe(200);
    expect(res.body.establishment.active).toBe(false);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_establishment_suspended' }));
  });

  test('404 when the establishment does not exist', async () => {
    setSession();
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .patch('/api/platform/999')
      .set('x-session-token', 'valid')
      .send({ name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/platform/:id/audit (support)', () => {
  test('returns audit rows for the establishment', async () => {
    setSession();
    query.mockResolvedValueOnce({ rows: [{ id: 1, action: 'staff_login', created_at: new Date().toISOString() }] });

    const res = await request(app)
      .get('/api/platform/1/audit')
      .set('x-session-token', 'valid');

    expect(res.status).toBe(200);
    expect(res.body.audit).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM audit_log'),
      expect.arrayContaining(['1'])
    );
  });
});

describe('POST /api/platform/:id/force-logout (support)', () => {
  test('revokes sessions and audits', async () => {
    setSession();
    deleteSessionsByEstablishment.mockResolvedValueOnce(3);

    const res = await request(app)
      .post('/api/platform/1/force-logout')
      .set('x-session-token', 'valid');

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(3);
    expect(deleteSessionsByEstablishment).toHaveBeenCalledWith('1');
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_force_logout' }));
  });
});

describe('POST /api/platform/:id/clients/:clientId/rotate-token (support)', () => {
  test('rotates the token and returns the new plaintext once', async () => {
    setSession();
    query
      .mockResolvedValueOnce({ rows: [{ id: 7, full_name: 'Ana' }] })  // SELECT client
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });              // UPDATE token

    const res = await request(app)
      .post('/api/platform/1/clients/7/rotate-token')
      .set('x-session-token', 'valid');

    expect(res.status).toBe(200);
    expect(res.body.client_id).toBe(7);
    expect(res.body.access_token).toMatch(/^[a-f0-9]{48}$/);
    // Stored value must be the sha256 hash, never the plaintext.
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE clients SET access_token'),
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)])
    );
  });

  test('404 when the client is not in the establishment', async () => {
    setSession();
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post('/api/platform/1/clients/7/rotate-token')
      .set('x-session-token', 'valid');
    expect(res.status).toBe(404);
  });
});