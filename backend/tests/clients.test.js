import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const query = jest.fn();
const pool = { connect: jest.fn() };
jest.unstable_mockModule('../src/db/pool.js', () => ({ pool, query }));

// The real session.js is file-backed and does not see test tokens. Mock it so
// requireStaffSession resolves tokens from global.__beerposSessions.
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

const { default: clientsRouter } = await import('../src/routes/clients.js');
const app = express();
app.use(express.json());
app.use('/api/clients', clientsRouter);

function configureClientDatabase(clientRow = {
  id: 7,
  establishment_id: 1,
  full_name: 'Cliente de prueba',
  current_balance: 5,
  beer_price_usd: '1.50'
}) {
  const dbQuery = jest.fn(async (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT c.id, c.establishment_id')) {
      return { rows: clientRow ? [clientRow] : [], rowCount: clientRow ? 1 : 0 };
    }
    if (sql.includes('SELECT usd_to_ves')) {
      return { rows: [{ usd_to_ves: '36.50' }], rowCount: 1 };
    }
    if (sql.includes('UPDATE clients SET current_balance')) {
      return { rows: [{ current_balance: 7 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const release = jest.fn();
  pool.connect.mockResolvedValue({ query: dbQuery, release });
  return { dbQuery, release };
}

describe('POST /api/clients/:id/charge-combo', () => {
  beforeEach(() => {
    pool.connect.mockReset();
    globalThis.__beerposSessions = {
      valid: { staff: {}, establishment_id: 1, expiresAt: Date.now() + 3600000 },
    };
  });

  test('rejects invalid quantities before opening a database transaction', async () => {
    const response = await request(app)
      .post('/api/clients/7/charge-combo')
      .set('x-session-token', 'valid')
      .send({ quantity: 0 });

    expect(response.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('credits the balance and records the USD/VES purchase atomically', async () => {
    const { dbQuery, release } = configureClientDatabase();
    const response = await request(app)
      .post('/api/clients/7/charge-combo')
      .set('x-session-token', 'valid')
      .send({ quantity: 2, payment_method: 'cash' });

    expect(response.status).toBe(200);
    expect(response.body.client.current_balance).toBe(7);
    expect(response.body.amount_usd).toBe('3.00');
    expect(response.body.amount_ves).toBe('109.50');
    expect(dbQuery.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
      'BEGIN',
      'COMMIT'
    ]));
    const insert = dbQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO transactions'));
    expect(insert[1]).toEqual([1, 7, null, 2, '3.00', '109.50', 'cash']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('returns not found without recording a charge for an unknown client', async () => {
    const { dbQuery } = configureClientDatabase(null);
    const response = await request(app)
      .post('/api/clients/999/charge-combo')
      .set('x-session-token', 'valid')
      .send({ quantity: 1 });

    expect(response.status).toBe(404);
    expect(dbQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO transactions'))).toBe(false);
    expect(dbQuery).toHaveBeenCalledWith('ROLLBACK');
  });
});
