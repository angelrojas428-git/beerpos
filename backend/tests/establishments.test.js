import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const query = jest.fn();
jest.unstable_mockModule('../src/db/pool.js', () => ({ pool: { connect: jest.fn() }, query }));

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

const { default: establishmentsRouter } = await import('../src/routes/establishments.js');

const app = express();
app.use(express.json());
app.use('/api/establishments', establishmentsRouter);

function setStaffSession(establishmentId = 1) {
  globalThis.__beerposSessions = {
    valid: { staff: { id: 1, role: 'owner' }, establishment_id: establishmentId, expiresAt: Date.now() + 3600000 },
  };
}

describe('Establishments multi-tenant isolation', () => {
  beforeEach(() => {
    query.mockReset();
    delete globalThis.__beerposSessions;
  });

  test('PATCH requires authentication (401 without token)', async () => {
    const response = await request(app)
      .patch('/api/establishments/1')
      .send({ name: 'X' });

    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  test('staff cannot modify another establishment (403 on id mismatch)', async () => {
    setStaffSession(1); // session belongs to establishment 1
    const response = await request(app)
      .patch('/api/establishments/2') // but tries to modify establishment 2
      .set('x-session-token', 'valid')
      .send({ name: 'Hacked' });

    expect(response.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  test('owner can update their own establishment', async () => {
    setStaffSession(1);
    query.mockResolvedValue({ rows: [{ id: 1, name: 'Updated', active: true }], rowCount: 1 });

    const response = await request(app)
      .patch('/api/establishments/1')
      .set('x-session-token', 'valid')
      .send({ name: 'Updated' });

    expect(response.status).toBe(200);
    expect(response.body.name).toBe('Updated');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE establishments'),
      expect.any(Array)
    );
  });
});