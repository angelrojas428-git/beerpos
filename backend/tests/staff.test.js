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

const { default: staffRouter } = await import('../src/routes/staff.js');

const app = express();
app.use(express.json());
app.use('/api/staff', staffRouter);

function setSession({ id = 1, role = 'owner', establishment_id = 1 } = {}) {
  globalThis.__beerposSessions = {
    valid: { staff: { id, role }, establishment_id, expiresAt: Date.now() + 3600000 },
  };
}

const auth = { 'x-session-token': 'valid' };

beforeEach(() => {
  query.mockReset();
  auditLog.mockReset();
  delete globalThis.__beerposSessions;
  setSession();
});

describe('staff management', () => {
  test('GET lists staff', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Owner', role: 'owner', active: true }] });
    const res = await request(app).get('/api/staff').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('POST creates a bartender (owner)', async () => {
    query
      .mockResolvedValueOnce({ rows: [] }) // duplicate check
      .mockResolvedValueOnce({ rows: [{ id: 2, name: 'Luis', role: 'bartender', active: true }] }); // insert
    const res = await request(app).post('/api/staff').set(auth).send({ name: 'Luis', pin: '135790', role: 'bartender' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Luis');
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'staff_create' }));
  });

  test('POST rejects non-owner', async () => {
    setSession({ id: 2, role: 'bartender' });
    const res = await request(app).post('/api/staff').set(auth).send({ name: 'X', pin: '135790' });
    expect(res.status).toBe(403);
  });

  test('POST rejects short PIN', async () => {
    const res = await request(app).post('/api/staff').set(auth).send({ name: 'X', pin: '123' });
    expect(res.status).toBe(400);
  });

  test('POST rejects duplicate name', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const res = await request(app).post('/api/staff').set(auth).send({ name: 'Luis', pin: '135790' });
    expect(res.status).toBe(409);
  });

  test('PATCH updates a staff member', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 2, name: 'Luis', role: 'bartender', active: true }] }) // existing
      .mockResolvedValueOnce({ rows: [{ id: 2, name: 'Luis', role: 'bartender', active: false }] }); // update
    const res = await request(app).patch('/api/staff/2').set(auth).send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'staff_update' }));
  });

  test('PATCH prevents deactivating yourself', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Owner', role: 'owner', active: true }] });
    const res = await request(app).patch('/api/staff/1').set(auth).send({ active: false });
    expect(res.status).toBe(400);
  });

  test('PATCH prevents removing the last owner', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Owner', role: 'owner', active: true }] }) // existing
      .mockResolvedValueOnce({ rows: [{ n: 0 }] }); // other owners
    setSession({ id: 9, role: 'owner' }); // someone else, so not self
    const res = await request(app).patch('/api/staff/1').set(auth).send({ active: false });
    expect(res.status).toBe(400);
  });

  test('DELETE deactivates a staff member', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 2, name: 'Luis', role: 'bartender', active: true }] }) // existing
      .mockResolvedValueOnce({ rows: [{ id: 2, name: 'Luis', role: 'bartender', active: false }] }); // update
    const res = await request(app).delete('/api/staff/2').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'staff_deactivate' }));
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/staff');
    expect(res.status).toBe(401);
  });
});