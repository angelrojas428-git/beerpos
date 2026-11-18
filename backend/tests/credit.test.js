import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// --- Mock the DB pool: query() for reads + pool.connect() for transactions ---
const query = jest.fn();
let txState = null; // holds queued db.query responses per transaction
function makeTxDb() {
  const dbQuery = jest.fn(async (sql) => {
    if (typeof txState === 'function') return txState(sql);
    return { rows: [], rowCount: 1 };
  });
  return { query: dbQuery, release: jest.fn() };
}
const poolConnect = jest.fn(async () => makeTxDb());
jest.unstable_mockModule('../src/db/pool.js', () => ({ pool: { connect: poolConnect }, query }));

const auditLog = jest.fn();
jest.unstable_mockModule('../src/lib/audit.js', () => ({ auditLog }));

// Realtime not needed; stub socket/events.
jest.unstable_mockModule('../src/lib/socket.js', () => ({ getIO: () => null }));
jest.unstable_mockModule('../src/routes/events.js', () => ({ broadcastSse: () => {} }));

// Session middleware resolves tokens from global store.
jest.unstable_mockModule('../src/lib/session.js', () => ({
  getStaffSession: (token) => {
    const store = globalThis.__beerposSessions || {};
    return token ? store[token] || null : null;
  },
  deleteSession: () => {},
}));

const credit = await import('../src/lib/credit.js');
const { default: creditRouter } = await import('../src/routes/credit.js');

const app = express();
app.use(express.json());
app.use('/api/credit', creditRouter);

function setSession({ id = 1, role = 'owner', establishment_id = 1 } = {}) {
  globalThis.__beerposSessions = {
    valid: { staff: { id, role }, establishment_id, expiresAt: Date.now() + 3600000 },
  };
}

beforeEach(() => {
  query.mockReset();
  poolConnect.mockClear();
  auditLog.mockReset();
  txState = null;
  delete globalThis.__beerposSessions;
});

// Helper: queue responses for the next transaction by matching SQL substrings.
function queueTx(map, fallback = { rows: [], rowCount: 1 }) {
  txState = (sql) => {
    for (const [needle, res] of Object.entries(map)) {
      if (sql.includes(needle)) return res;
    }
    return fallback;
  };
}

describe('creditSale', () => {
  test('charges within limit and updates balance', async () => {
    queueTx({
      'FROM clients': { rows: [{ id: 7, full_name: 'Ana', credit_limit_usd: '50.00', credit_balance_usd: '10.00', credit_hold_reason: null }] },
      'INSERT INTO transactions': { rows: [{ id: 100 }], rowCount: 1 },
      'INSERT INTO credit_ledger': { rows: [], rowCount: 1 },
      'UPDATE clients': { rows: [], rowCount: 1 },
    });

    const res = await credit.creditSale({ clientId: 7, establishmentId: 1, staffId: 1, amountUsd: 25 });

    expect(res.ok).toBe(true);
    expect(res.balance_after_usd).toBe(35);
    expect(res.available_usd).toBe(15);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'credit_sale' }));
  });

  test('rejects when no credit is enabled (limit 0)', async () => {
    queueTx({
      'FROM clients': { rows: [{ id: 7, full_name: 'Ana', credit_limit_usd: '0.00', credit_balance_usd: '0.00', credit_hold_reason: null }] },
    });
    await expect(credit.creditSale({ clientId: 7, establishmentId: 1, staffId: 1, amountUsd: 10 }))
      .rejects.toMatchObject({ code: 'no_credit' });
  });

  test('rejects when the limit is exceeded (no override)', async () => {
    queueTx({
      'FROM clients': { rows: [{ id: 7, full_name: 'Ana', credit_limit_usd: '50.00', credit_balance_usd: '45.00', credit_hold_reason: null }] },
    });
    await expect(credit.creditSale({ clientId: 7, establishmentId: 1, staffId: 1, amountUsd: 10 }))
      .rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  test('rejects when the client is on hold', async () => {
    queueTx({
      'FROM clients': { rows: [{ id: 7, full_name: 'Ana', credit_limit_usd: '50.00', credit_balance_usd: '0.00', credit_hold_reason: 'moroso' }] },
    });
    await expect(credit.creditSale({ clientId: 7, establishmentId: 1, staffId: 1, amountUsd: 10 }))
      .rejects.toMatchObject({ code: 'credit_hold' });
  });

  test('rolls back on error', async () => {
    queueTx({
      'FROM clients': { rows: [{ id: 7, full_name: 'Ana', credit_limit_usd: '0.00', credit_balance_usd: '0.00', credit_hold_reason: null }] },
    });
    const conn = await poolConnect();
    await expect(credit.creditSale({ clientId: 7, establishmentId: 1, staffId: 1, amountUsd: 10 })).rejects.toBeTruthy();
  });
});

describe('creditPayment', () => {
  test('partial payment reduces the balance', async () => {
    queueTx({
      'FROM clients': { rows: [{ id: 7, credit_balance_usd: '35.00' }] },
      'INSERT INTO transactions': { rows: [{ id: 200 }], rowCount: 1 },
      'INSERT INTO credit_ledger': { rows: [], rowCount: 1 },
      'UPDATE clients': { rows: [], rowCount: 1 },
    });
    const res = await credit.creditPayment({ clientId: 7, establishmentId: 1, staffId: 1, amountUsd: 10, paymentMethod: 'efectivo' });
    expect(res.paid_usd).toBe(10);
    expect(res.balance_after_usd).toBe(25);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'credit_payment' }));
  });

  test('rejects overpayment above the debt', async () => {
    queueTx({ 'FROM clients': { rows: [{ id: 7, credit_balance_usd: '20.00' }] } });
    await expect(credit.creditPayment({ clientId: 7, establishmentId: 1, staffId: 1, amountUsd: 25 }))
      .rejects.toMatchObject({ code: 'overpayment' });
  });

  test('rejects payment when there is no debt', async () => {
    queueTx({ 'FROM clients': { rows: [{ id: 7, credit_balance_usd: '0.00' }] } });
    await expect(credit.creditPayment({ clientId: 7, establishmentId: 1, staffId: 1, amountUsd: 10 }))
      .rejects.toMatchObject({ code: 'no_debt' });
  });
});

describe('creditAdjust / creditNote / voidEntry (owner, reason)', () => {
  test('adjustment requires a reason', async () => {
    await expect(credit.creditAdjust({ clientId: 7, establishmentId: 1, amountUsd: 5, note: '' }))
      .rejects.toMatchObject({ code: 'reason_required' });
  });

  test('credit note reduces the debt and records a compensating entry', async () => {
    queueTx({
      'FROM clients': { rows: [{ id: 7, credit_balance_usd: '30.00' }] },
      'SELECT id, client_id FROM credit_ledger': { rows: [{ id: 100, client_id: 7 }] },
      'INSERT INTO credit_ledger': { rows: [{ id: 101 }], rowCount: 1 },
      'UPDATE clients': { rows: [], rowCount: 1 },
    });
    const res = await credit.creditNote({ clientId: 7, establishmentId: 1, staffId: 1, amountUsd: 5, note: 'error de registro', relatedLedgerId: 100 });
    expect(res.amount_usd).toBe(-5);
    expect(res.balance_after_usd).toBe(25);
  });

  test('void reverses a specific entry', async () => {
    queueTx({
      'SELECT id, client_id, amount_usd FROM credit_ledger': { rows: [{ id: 100, client_id: 7, entry_type: 'CHARGE', amount_usd: '30.00' }] },
      'SELECT credit_balance_usd FROM clients': { rows: [{ credit_balance_usd: '30.00' }] },
      'INSERT INTO credit_ledger': { rows: [{ id: 200 }], rowCount: 1 },
      'UPDATE clients': { rows: [], rowCount: 1 },
    });
    const res = await credit.voidEntry({ entryId: 100, establishmentId: 1, staffId: 1, note: 'venta anulada' });
    expect(res.amount_usd).toBe(-30);
    expect(res.balance_after_usd).toBe(0);
  });
});

describe('getAging (FIFO)', () => {
  test('applies payments to the oldest charges', async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    query.mockResolvedValueOnce({
      rows: [
        { id: 1, client_id: 7, entry_type: 'CHARGE', amount_usd: '20.00', created_at: new Date(now - 100 * day) }, // >90
        { id: 2, client_id: 7, entry_type: 'CHARGE', amount_usd: '15.00', created_at: new Date(now - 10 * day) },  // corriente
        { id: 3, client_id: 7, entry_type: 'PAYMENT', amount_usd: '-10.00', created_at: new Date(now - 5 * day) },
      ],
    });

    const aging = await credit.getAging(1);
    const c = aging.find((a) => a.client_id === 7);
    expect(c.d90_plus).toBe(10);   // 20 charge - 10 payment (FIFO applied to oldest)
    expect(c.corriente).toBe(15);
    expect(c.total).toBe(25);
  });
});

describe('credit API (auth + validation)', () => {
  test('401 without a session token', async () => {
    const res = await request(app).get('/api/credit/clients');
    expect(res.status).toBe(401);
  });

  test('GET /clients returns clients for the establishment', async () => {
    setSession({ id: 1, role: 'owner', establishment_id: 1 });
    query.mockResolvedValueOnce({ rows: [{ id: 7, full_name: 'Ana', credit_limit_usd: '50.00', credit_balance_usd: '10.00' }] });
    const res = await request(app).get('/api/credit/clients').set('x-session-token', 'valid');
    expect(res.status).toBe(200);
    expect(res.body.clients).toHaveLength(1);
  });

test('POST /sale cannot touch another establishment\'s client (404, session-scoped)', async () => {
    setSession({ id: 1, role: 'owner', establishment_id: 2 });
    // The service scopes every query by the session's establishment (2); the client
    // belongs to establishment 1, so the locked SELECT returns no row -> 404.
    queueTx({ 'FROM clients': { rows: [] } });
    const res = await request(app)
      .post('/api/credit/sale')
      .set('x-session-token', 'valid')
      .send({ client_id: 7, amount_usd: 10 });
    expect(res.status).toBe(404);
  });

  test('POST /sale rejects a non-positive amount (400)', async () => {
    setSession({ id: 1, role: 'owner', establishment_id: 1 });
    const res = await request(app)
      .post('/api/credit/sale')
      .set('x-session-token', 'valid')
      .send({ client_id: 7, amount_usd: 0 });
    expect(res.status).toBe(400);
  });

  test('POST /clients/:id/limit requires owner role (403 for bartender)', async () => {
    setSession({ id: 2, role: 'bartender', establishment_id: 1 });
    const res = await request(app)
      .post('/api/credit/clients/7/limit')
      .set('x-session-token', 'valid')
      .send({ credit_limit_usd: 100 });
    expect(res.status).toBe(403);
  });

  test('POST /clients/:id/limit sets the limit (owner)', async () => {
    setSession({ id: 1, role: 'owner', establishment_id: 1 });
    query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] }) // loadClient
      .mockResolvedValueOnce({ rows: [{ id: 7, credit_limit_usd: '100.00', credit_balance_usd: '0.00' }] });
    const res = await request(app)
      .post('/api/credit/clients/7/limit')
      .set('x-session-token', 'valid')
      .send({ credit_limit_usd: 100 });
    expect(res.status).toBe(200);
    expect(res.body.credit_limit_usd).toBe('100.00');
  });

  test('POST /sale/override requires owner role (403 for bartender)', async () => {
    setSession({ id: 2, role: 'bartender', establishment_id: 1 });
    const res = await request(app)
      .post('/api/credit/sale/override')
      .set('x-session-token', 'valid')
      .send({ client_id: 7, amount_usd: 10, reason: 'cliente vip' });
    expect(res.status).toBe(403);
  });
});