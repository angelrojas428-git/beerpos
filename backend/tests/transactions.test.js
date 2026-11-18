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

const { default: transactionsRouter, isCalendarDate } = await import('../src/routes/transactions.js');
const app = express();
app.use('/api/transactions', transactionsRouter);

describe('GET /api/transactions/report/:establishmentId', () => {
  beforeEach(() => {
    query.mockReset();
    globalThis.__beerposSessions = {
      valid: { staff: { id: 1 }, establishment_id: 1, expiresAt: Date.now() + 3600000 },
    };
  });

  test('validates real calendar dates, including leap days', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('12-11-2026')).toBe(false);
  });

  test('rejects malformed or impossible calendar dates', async () => {
    const response = await request(app)
      .get('/api/transactions/report/1')
      .set('x-session-token', 'valid')
      .query({ date: '2026-02-31' });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  test('requires a staff session (401 without token)', async () => {
    const response = await request(app)
      .get('/api/transactions/report/1')
      .query({ date: '2026-11-12' });

    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  test('returns daily revenue and dispatch totals for the selected establishment', async () => {
    // Distinct results per query so the assembled response can be asserted.
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT s.name as bartender_name')) {
        return { rows: [{ bartender_name: 'Ana', beers_dispatched: '8', redemption_count: '2' }] };
      }
      if (sql.includes('created_at::date as day')) {
        return { rows: [{ day: '2026-11-12', beers_sold: '18', beers_dispatched: '12', revenue_usd: '27.00', revenue_ves: '985.50' }] };
      }
      // Aggregate report query.
      return {
        rows: [{
          beers_sold: '18', beers_dispatched: '12', fast_sold: '0',
          revenue_usd: '27.00', revenue_ves: '985.50',
          combo_count: '1', redemption_count: '2', fast_sale_count: '0'
        }],
      };
    });

    const response = await request(app)
      .get('/api/transactions/report/3')
      .set('x-session-token', 'valid')
      .query({ date: '2026-11-12' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      report_date: '2026-11-12',
      beers_sold: 18,
      beers_dispatched: 12,
      revenue_usd: '27.00',
      revenue_ves: '985.50',
      combo_count: 1,
      redemption_count: 2,
      fast_sale_count: 0,
    });
    expect(response.body.dispatches_by_bartender).toEqual([
      { bartender_name: 'Ana', beers_dispatched: '8', redemption_count: '2' },
    ]);
    expect(response.body.daily_breakdown).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('beers_sold'), ['3', '2026-11-12']);
  });
});
