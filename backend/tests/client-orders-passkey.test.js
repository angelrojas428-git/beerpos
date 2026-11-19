import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { hashAccessToken } from '../src/lib/token.js';

const query = jest.fn();
const dbQuery = jest.fn();
const pool = {
  connect: jest.fn(async () => ({ query: dbQuery, release: jest.fn() })),
};
let authorizationAvailable;
let clientHasPasskey;
let staffSession;
jest.unstable_mockModule('../src/db/pool.js', () => ({ pool, query }));
jest.unstable_mockModule('../src/lib/session.js', () => ({
  getStaffSession: async (token) => token === 'staff' ? staffSession : null,
}));
jest.unstable_mockModule('../src/lib/audit.js', () => ({ auditLog: async () => {} }));
jest.unstable_mockModule('../src/lib/socket.js', () => ({ emitToRoom: () => {} }));
jest.unstable_mockModule('../src/routes/events.js', () => ({ broadcastSse: () => {} }));

const { default: router } = await import('../src/routes/client_orders.js');
const app = express();
app.use(express.json());
app.use('/api/client-orders', router);

describe('POST /api/client-orders passkey enforcement', () => {
  beforeEach(() => {
    query.mockReset();
    dbQuery.mockReset();
    pool.connect.mockClear();
    authorizationAvailable = true;
    clientHasPasskey = true;
    staffSession = null;
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM clients') && sql.includes('access_token')) {
        return { rows: [{ id: 7 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    dbQuery.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT c.id, c.establishment_id')) {
        return {
          rows: [{ id: 7, establishment_id: 1, full_name: 'Cliente', current_balance: 4 }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM client_passkeys')) {
        return clientHasPasskey ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('DELETE FROM client_passkey_authorizations')) {
        if (params[3] !== 1) return { rows: [], rowCount: 0 };
        if (!authorizationAvailable) return { rows: [], rowCount: 0 };
        authorizationAvailable = false;
        return { rows: [{ token_hash: 'consumed' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO client_orders')) {
        return { rows: [{ id: 17, requested_at: new Date(), expires_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
  });

  test('denies enrolled clients without a passkey authorization', async () => {
    const response = await request(app)
      .post('/api/client-orders')
      .set('x-client-token', 'client-token')
      .send({ establishment_id: 1, client_id: 7, quantity: 1 });

    expect(response.status).toBe(401);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(dbQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(dbQuery).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM client_passkey_authorizations'), expect.anything());
  });

  test('consumes a valid one-time passkey authorization before creating the order', async () => {
    const mismatchedQuantity = await request(app)
      .post('/api/client-orders')
      .set('x-client-token', 'client-token')
      .set('x-client-passkey-auth', 'passkey-authorization')
      .send({ establishment_id: 1, client_id: 7, quantity: 2 });
    expect(mismatchedQuantity.status).toBe(401);

    const response = await request(app)
      .post('/api/client-orders')
      .set('x-client-token', 'client-token')
      .set('x-client-passkey-auth', 'passkey-authorization')
      .send({ establishment_id: 1, client_id: 7, quantity: 1 });

    expect(response.status).toBe(201);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM client_passkey_authorizations'),
      [hashAccessToken('passkey-authorization'), 7, 1, 1]
    );
    expect(dbQuery).toHaveBeenCalledWith('COMMIT');

    const replay = await request(app)
      .post('/api/client-orders')
      .set('x-client-token', 'client-token')
      .set('x-client-passkey-auth', 'passkey-authorization')
      .send({ establishment_id: 1, client_id: 7, quantity: 1 });
    expect(replay.status).toBe(401);
    expect(pool.connect).toHaveBeenCalledTimes(3);
  });

  test('keeps the existing withdrawal flow for clients without passkeys', async () => {
    clientHasPasskey = false;

    const response = await request(app)
      .post('/api/client-orders')
      .set('x-client-token', 'client-token')
      .send({ establishment_id: 1, client_id: 7, quantity: 1 });

    expect(response.status).toBe(201);
    expect(dbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM client_passkey_authorizations'),
      expect.anything()
    );
  });

  test('keeps authenticated staff ordering available for enrolled clients at the POS', async () => {
    staffSession = { establishment_id: 1, staff: { id: 8 } };

    const response = await request(app)
      .post('/api/client-orders')
      .set('x-session-token', 'staff')
      .send({ establishment_id: 1, client_id: 7, quantity: 1 });

    expect(response.status).toBe(201);
    expect(dbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM client_passkey_authorizations'),
      expect.anything()
    );
  });
});
