import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const query = jest.fn();
jest.unstable_mockModule('../src/db/pool.js', () => ({ pool: { connect: jest.fn() }, query }));

const { default: healthRouter } = await import('../src/routes/health.js');

const app = express();
app.use(express.json());
app.use('/api/health', healthRouter);

describe('GET /api/health/live (public liveness)', () => {
  beforeEach(() => {
    query.mockReset();
  });

  test('returns 200 when the DB answers SELECT 1 (no auth required)', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const res = await request(app).get('/api/health/live');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.db).toBe('up');
    expect(typeof res.body.uptime_s).toBe('number');
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  test('returns 503 when the DB query fails', async () => {
    query.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app).get('/api/health/live');

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.db).toBe('down');
    expect(res.body.error).toBe('connection refused');
  });

  test('detailed GET / still requires auth (401 without token)', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});