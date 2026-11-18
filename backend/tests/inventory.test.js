import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Mock the DB pool and audit helper (unit-test the route, like credit.test.js).
const query = jest.fn();
jest.unstable_mockModule('../src/db/pool.js', () => ({ query, pool: {} }));

const auditLog = jest.fn();
jest.unstable_mockModule('../src/lib/audit.js', () => ({ auditLog }));

jest.unstable_mockModule('../src/lib/session.js', () => ({
  getStaffSession: (token) => {
    const store = globalThis.__beerposSessions || {};
    return token ? store[token] || null : null;
  },
  deleteSession: () => {},
}));

const { default: inventoryRouter } = await import('../src/routes/inventory.js');

const app = express();
app.use(express.json());
app.use('/api/inventory', inventoryRouter);

function setSession({ establishment_id = 1 } = {}) {
  globalThis.__beerposSessions = {
    valid: { staff: { id: 1, role: 'bartender' }, establishment_id, expiresAt: Date.now() + 3600000 },
  };
}

const auth = { 'x-session-token': 'valid' };

beforeEach(() => {
  query.mockReset();
  auditLog.mockReset();
  delete globalThis.__beerposSessions;
  setSession();
});

describe('inventory', () => {
  test('GET returns stock and computes low_stock', async () => {
    query.mockResolvedValueOnce({ rows: [{ beer_stock: 5, beer_stock_min: 10, stock_updated_at: '2026-11-18' }] });
    const res = await request(app).get('/api/inventory/1').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.beer_stock).toBe(5);
    expect(res.body.beer_stock_min).toBe(10);
    expect(res.body.low_stock).toBe(true);
  });

  test('GET returns null stock (untracked) without low_stock', async () => {
    query.mockResolvedValueOnce({ rows: [{ beer_stock: null, beer_stock_min: 10, stock_updated_at: null }] });
    const res = await request(app).get('/api/inventory/1').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.beer_stock).toBe(null);
    expect(res.body.low_stock).toBe(false);
  });

  test('GET rejects a different establishment', async () => {
    const res = await request(app).get('/api/inventory/2').set(auth);
    expect(res.status).toBe(403);
  });

  test('PUT rejects negative stock', async () => {
    const res = await request(app).put('/api/inventory/1').set(auth).send({ beer_stock: -1 });
    expect(res.status).toBe(400);
  });

  test('PUT sets stock and writes audit log', async () => {
    query.mockResolvedValueOnce({ rows: [{ beer_stock: 50, beer_stock_min: 10, stock_updated_at: '2026-11-18' }] });
    const res = await request(app).put('/api/inventory/1').set(auth).send({ beer_stock: 50 });
    expect(res.status).toBe(200);
    expect(res.body.beer_stock).toBe(50);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'stock_set' }));
  });

  test('PUT accepts null to disable tracking', async () => {
    query.mockResolvedValueOnce({ rows: [{ beer_stock: null, beer_stock_min: 10, stock_updated_at: '2026-11-18' }] });
    const res = await request(app).put('/api/inventory/1').set(auth).send({ beer_stock: null });
    expect(res.status).toBe(200);
    expect(res.body.beer_stock).toBe(null);
  });

  test('PUT with nothing to update returns 400', async () => {
    const res = await request(app).put('/api/inventory/1').set(auth).send({});
    expect(res.status).toBe(400);
  });

  test('POST adjust sends a signed delta and logs it', async () => {
    query.mockResolvedValueOnce({ rows: [{ beer_stock: 49, beer_stock_min: 10, stock_updated_at: '2026-11-18' }] });
    const res = await request(app).post('/api/inventory/1/adjust').set(auth).send({ delta: -1 });
    expect(res.status).toBe(200);
    expect(res.body.beer_stock).toBe(49);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('COALESCE(beer_stock, 0)'), [-1, 1]);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'stock_adjust' }));
  });

  test('POST adjust rejects zero delta', async () => {
    const res = await request(app).post('/api/inventory/1/adjust').set(auth).send({ delta: 0 });
    expect(res.status).toBe(400);
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/inventory/1');
    expect(res.status).toBe(401);
  });
});