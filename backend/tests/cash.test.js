import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

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

const { default: cashRouter } = await import('../src/routes/cash.js');

const app = express();
app.use(express.json());
app.use('/api/cash', cashRouter);

function setSession({ establishment_id = 1 } = {}) {
  globalThis.__beerposSessions = {
    valid: { staff: { id: 1, role: 'owner' }, establishment_id, expiresAt: Date.now() + 3600000 },
  };
}

const auth = { 'x-session-token': 'valid' };

beforeEach(() => {
  query.mockReset();
  auditLog.mockReset();
  delete globalThis.__beerposSessions;
  setSession();
});

describe('cash shifts', () => {
  test('GET /current returns open:false when no shift', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/cash/current').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.open).toBe(false);
  });

  test('GET /current returns live totals when open', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 5, opened_at: '2026-11-18T10:00:00Z', opening_float_usd: '50.00' }] })
      .mockResolvedValueOnce({ rows: [{ cash_in_usd: '100.00', non_cash_in_usd: '20.00', total_sales_usd: '120.00', sales_count: 4 }] });
    const res = await request(app).get('/api/cash/current').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.open).toBe(true);
    expect(res.body.expected_usd).toBe(150);
    expect(res.body.totals.cash_in_usd).toBe(100);
  });

  test('POST /open creates a shift', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 5, opened_at: '2026-11-18T11:00:00Z', opening_float_usd: '75.00' }] });
    const res = await request(app).post('/api/cash/open').set(auth).send({ opening_float_usd: 75 });
    expect(res.status).toBe(201);
    expect(res.body.open).toBe(true);
    expect(res.body.expected_usd).toBe(75);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'cash_open' }));
  });

  test('POST /open rejects negative float', async () => {
    const res = await request(app).post('/api/cash/open').set(auth).send({ opening_float_usd: -1 });
    expect(res.status).toBe(400);
  });

  test('POST /open returns 409 when a shift is already open', async () => {
    const err = new Error('duplicate');
    err.code = '23505';
    query.mockRejectedValueOnce(err);
    const res = await request(app).post('/api/cash/open').set(auth).send({ opening_float_usd: 0 });
    expect(res.status).toBe(409);
  });

  test('POST /close computes expected and difference', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 5, opened_at: '2026-11-18T10:00:00Z', opening_float_usd: '50.00' }] })
      .mockResolvedValueOnce({ rows: [{ cash_in_usd: '100.00', non_cash_in_usd: '0', total_sales_usd: '100.00', sales_count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 5, status: 'CLOSED', difference_usd: '-5.00' }] });
    const res = await request(app).post('/api/cash/close').set(auth).send({ counted_usd: 145 });
    expect(res.status).toBe(200);
    expect(res.body.open).toBe(false);
    expect(Number(res.body.shift.difference_usd)).toBe(-5);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'cash_close' }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('difference_usd'), expect.arrayContaining([145]));
  });

  test('POST /close returns 404 when no shift is open', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/api/cash/close').set(auth).send({ counted_usd: 100 });
    expect(res.status).toBe(404);
  });

  test('GET /history lists closed shifts', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 5, status: 'CLOSED' }] });
    const res = await request(app).get('/api/cash/history').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/cash/current');
    expect(res.status).toBe(401);
  });
});