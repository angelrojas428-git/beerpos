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

const { default: redemptionsRouter } = await import('../src/routes/redemptions.js');
const app = express();
app.use(express.json());
app.use('/api/redemptions', redemptionsRouter);

describe('POST /api/redemptions/fast/:id/dispatch', () => {
  beforeEach(() => {
    query.mockReset();
    delete global.__beerposSessions;
  });

  test('marks a pending code completed and attributes it to the logged-in bartender', async () => {
    const redemption = {
      id: 12,
      establishment_id: 1,
      code: '042',
      quantity: 3,
      status: 'COMPLETED',
      dispatched_by_staff_id: 5
    };
    global.__beerposSessions = {
      valid: {
        staff: { id: 5 },
        establishment_id: 1,
        expiresAt: Date.now() + 60_000
      }
    };
    query.mockResolvedValue({ rows: [redemption], rowCount: 1 });

    const response = await request(app)
      .post('/api/redemptions/fast/12/dispatch')
      .set('x-session-token', 'valid');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'COMPLETED', dispatched_by_staff_id: 5 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('dispatched_at = NOW()'), ['12', 5, 1]);
  });

  test('returns 404 when the code is already completed or does not exist', async () => {
    global.__beerposSessions = {
      valid: { staff: { id: 5 }, establishment_id: 1, expiresAt: Date.now() + 60_000 }
    };
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    const response = await request(app)
      .post('/api/redemptions/fast/12/dispatch')
      .set('x-session-token', 'valid');

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/already completed/);
  });

  test('rejects an expired staff session instead of recording a bartender', async () => {
    global.__beerposSessions = {
      expired: {
        staff: { id: 5 },
        establishment_id: 1,
        expiresAt: Date.now() - 1
      }
    };

    const response = await request(app)
      .post('/api/redemptions/fast/12/dispatch')
      .set('x-session-token', 'expired');

    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});
