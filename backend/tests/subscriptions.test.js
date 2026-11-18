import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const query = jest.fn();
const poolConnect = jest.fn();
jest.unstable_mockModule('../src/db/pool.js', () => ({ pool: { connect: poolConnect }, query }));

const deleteSessionsByEstablishment = jest.fn();
jest.unstable_mockModule('../src/lib/session.js', () => ({
  getStaffSession: (token) => {
    const store = globalThis.__beerposSessions || {};
    return token ? store[token] || null : null;
  },
  deleteSessionsByEstablishment,
}));

const auditLog = jest.fn();
jest.unstable_mockModule('../src/lib/audit.js', () => ({ auditLog }));

const subs = await import('../src/lib/subscriptions.js');
const { listPlans, getPlan, checkLimit, isKnownPlan } = await import('../src/lib/plans.js');
const { default: platformRouter } = await import('../src/routes/platform.js');

const app = express();
app.use(express.json());
app.use('/api/platform', platformRouter);

function setSession({ id = 99, role = 'platform_admin' } = {}) {
  globalThis.__beerposSessions = {
    valid: { staff: { id, role }, establishment_id: null, expiresAt: Date.now() + 3600000 },
  };
}

beforeEach(() => {
  query.mockReset();
  poolConnect.mockReset();
  deleteSessionsByEstablishment.mockReset();
  auditLog.mockReset();
  delete globalThis.__beerposSessions;
});

describe('plans catalog', () => {
  test('lists the four plans', () => {
    const ids = listPlans().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['free', 'pro', 'business', 'enterprise']));
  });

  test('unknown plan falls back to free', () => {
    expect(getPlan('nope').id).toBe('free');
    expect(isKnownPlan('pro')).toBe(true);
    expect(isKnownPlan('nope')).toBe(false);
  });

  test('checkLimit: free plan caps clients at 20', () => {
    expect(checkLimit('free', 'maxClients', 19)).toEqual({ allowed: true, limit: 20 });
    expect(checkLimit('free', 'maxClients', 20)).toEqual({ allowed: false, limit: 20 });
    // pro has no client limit.
    expect(checkLimit('pro', 'maxClients', 9999)).toEqual({ allowed: true, limit: null });
  });
});

describe('subscriptions service', () => {
  test('suspendSubscription disables the establishment and revokes sessions', async () => {
    query
      .mockResolvedValueOnce({ rowCount: 1 })              // UPDATE subscriptions
      .mockResolvedValueOnce({ rowCount: 1 });             // UPDATE establishments
    deleteSessionsByEstablishment.mockResolvedValueOnce(2);

    const res = await subs.suspendSubscription(5, 'non_payment');

    expect(res.suspended).toBe(true);
    expect(res.removed_sessions).toBe(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE subscriptions SET status'),
      expect.any(Array)
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE establishments SET active = FALSE'),
      [5]
    );
    expect(deleteSessionsByEstablishment).toHaveBeenCalledWith(5);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'subscription_suspended' }));
  });

  test('recordPayment extends the period and reactivates the establishment', async () => {
    const dbQuery = jest.fn(async (sql) => {
      if (sql.includes('INSERT INTO subscriptions')) {
        return { rows: [{ id: 1, establishment_id: 5, status: 'active', plan: 'pro' }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const db = { query: dbQuery, release: jest.fn() };
    poolConnect.mockResolvedValueOnce(db);

    const res = await subs.recordPayment(5, { months: 2, payment_method: 'pago_movil', amount_usd: 24, reference: 'REF-1' });

    expect(res.establishment_active).toBe(true);
    expect(res.subscription.status).toBe('active');
    const sqls = dbQuery.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('BEGIN'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE establishments SET active = TRUE'))).toBe(true);
    expect(sqls.some((s) => s.includes('COMMIT'))).toBe(true);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'subscription_payment_recorded',
      details: expect.objectContaining({ payment_method: 'pago_movil', amount_usd: 24, reference: 'REF-1' }),
    }));
  });

  test('sweepExpiredSubscriptions suspends every expired subscription', async () => {
    // SELECT expired -> two establishments
    query.mockResolvedValueOnce({ rows: [{ establishment_id: 5 }, { establishment_id: 6 }] });
    // Each suspendSubscription: UPDATE subscriptions + UPDATE establishments (x2)
    query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });
    deleteSessionsByEstablishment.mockResolvedValue(0);

    const count = await subs.sweepExpiredSubscriptions();
    expect(count).toBe(2);
    expect(deleteSessionsByEstablishment).toHaveBeenCalledTimes(2);
  });

  test('assignPlan changes the plan and audits', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, establishment_id: 5, plan: 'business', status: 'active' }] });

    const sub = await subs.assignPlan(5, 'business');
    expect(sub.plan).toBe('business');
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'subscription_plan_changed' }));
  });

  test('listSubscriptions returns rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, establishment_id: 5, establishment_name: 'Tasca', plan: 'pro', status: 'active' }] });
    const rows = await subs.listSubscriptions();
    expect(rows).toHaveLength(1);
    expect(rows[0].establishment_name).toBe('Tasca');
  });
});

describe('billing endpoints (/api/platform)', () => {
  test('401 without a platform admin session', async () => {
    const res = await request(app).get('/api/platform/subscriptions');
    expect(res.status).toBe(401);
  });

  test('403 for a non-platform-admin', async () => {
    setSession({ id: 1, role: 'owner' });
    const res = await request(app).get('/api/platform/plans').set('x-session-token', 'valid');
    expect(res.status).toBe(403);
  });

  test('GET /plans returns the catalog', async () => {
    setSession();
    const res = await request(app).get('/api/platform/plans').set('x-session-token', 'valid');
    expect(res.status).toBe(200);
    expect(res.body.plans.map((p) => p.id)).toEqual(expect.arrayContaining(['free', 'pro']));
  });

  test('GET /subscriptions lists subscriptions', async () => {
    setSession();
    query.mockResolvedValueOnce({ rows: [{ id: 1, establishment_name: 'Tasca', status: 'active' }] });
    const res = await request(app).get('/api/platform/subscriptions').set('x-session-token', 'valid');
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
  });

  test('PUT /:id/subscription assigns a plan', async () => {
    setSession();
    query.mockResolvedValueOnce({ rows: [{ id: 1, establishment_id: 5, plan: 'pro', status: 'active' }] });
    const res = await request(app)
      .put('/api/platform/5/subscription')
      .set('x-session-token', 'valid')
      .send({ plan: 'pro' });
    expect(res.status).toBe(200);
    expect(res.body.subscription.plan).toBe('pro');
  });

  test('PUT /:id/subscription rejects an unknown plan (400)', async () => {
    setSession();
    const res = await request(app)
      .put('/api/platform/5/subscription')
      .set('x-session-token', 'valid')
      .send({ plan: 'nope' });
    expect(res.status).toBe(400);
  });

  test('POST /:id/payment records a payment and reactivates', async () => {
    setSession();
    const dbQuery = jest.fn(async (sql) => {
      if (sql.includes('INSERT INTO subscriptions')) return { rows: [{ id: 1, establishment_id: 5, status: 'active', plan: 'pro' }] };
      return { rows: [], rowCount: 1 };
    });
    poolConnect.mockResolvedValueOnce({ query: dbQuery, release: jest.fn() });

    const res = await request(app)
      .post('/api/platform/5/payment')
      .set('x-session-token', 'valid')
      .send({ months: 1, payment_method: 'zelle', amount_usd: 12 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('POST /:id/suspend suspends and revokes sessions', async () => {
    setSession();
    query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });
    deleteSessionsByEstablishment.mockResolvedValueOnce(1);
    const res = await request(app)
      .post('/api/platform/5/suspend')
      .set('x-session-token', 'valid')
      .send({ reason: 'non_payment' });
    expect(res.status).toBe(200);
    expect(res.body.suspended).toBe(true);
  });
});

describe('pilots / free trials', () => {
  test('startPilot activates a pilot subscription and audits', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 1, establishment_id: 5, is_pilot: true, status: 'active' }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const sub = await subs.startPilot(5, { trialDays: 14 });
    expect(sub.is_pilot).toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO subscriptions'),
      expect.any(Array)
    );
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'pilot_started' }));
  });

  test('endPilot clears the pilot flags and audits', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, establishment_id: 5, is_pilot: false }] });
    const sub = await subs.endPilot(5);
    expect(sub.is_pilot).toBe(false);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'pilot_ended' }));
  });

  test('sweep considers expired pilots (SQL includes is_pilot)', async () => {
    query
      .mockResolvedValueOnce({ rows: [] }) // nothing to suspend
      ;
    await subs.sweepExpiredSubscriptions({ log: false });
    const sweepSql = query.mock.calls[0][0];
    expect(sweepSql).toContain('is_pilot');
    expect(sweepSql).toContain('trial_ends_at');
  });

  test('recordPayment clears the pilot flag', async () => {
    const dbQuery = jest.fn(async (sql) => {
      if (sql.includes('INSERT INTO subscriptions')) return { rows: [{ id: 1, establishment_id: 5, status: 'active', plan: 'pro' }] };
      return { rows: [], rowCount: 1 };
    });
    poolConnect.mockResolvedValueOnce({ query: dbQuery, release: jest.fn() });
    await subs.recordPayment(5, { months: 1, payment_method: 'manual', amount_usd: 12 });
    const insertSql = dbQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO subscriptions'))[0];
    expect(insertSql).toContain('is_pilot = FALSE');
  });

  test('POST /:id/pilot starts a pilot', async () => {
    setSession();
    query
      .mockResolvedValueOnce({ rows: [{ id: 1, establishment_id: 5, is_pilot: true, status: 'active' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app)
      .post('/api/platform/5/pilot')
      .set('x-session-token', 'valid')
      .send({ trial_days: 30 });
    expect(res.status).toBe(200);
    expect(res.body.subscription.is_pilot).toBe(true);
  });

  test('DELETE /:id/pilot ends a pilot', async () => {
    setSession();
    query.mockResolvedValueOnce({ rows: [{ id: 1, establishment_id: 5, is_pilot: false }] });
    const res = await request(app)
      .delete('/api/platform/5/pilot')
      .set('x-session-token', 'valid');
    expect(res.status).toBe(200);
    expect(res.body.subscription.is_pilot).toBe(false);
  });
});

describe('feedback', () => {
  test('POST /:id/feedback validates the rating (400)', async () => {
    setSession();
    const res = await request(app)
      .post('/api/platform/5/feedback')
      .set('x-session-token', 'valid')
      .send({ rating: 9 });
    expect(res.status).toBe(400);
  });

  test('POST /:id/feedback stores a valid rating (201) and audits', async () => {
    setSession();
    query.mockResolvedValueOnce({ rows: [{ id: 3, establishment_id: 5, rating: 5, comment: 'Excelente' }] });
    const res = await request(app)
      .post('/api/platform/5/feedback')
      .set('x-session-token', 'valid')
      .send({ rating: 5, comment: 'Excelente', category: 'usability' });
    expect(res.status).toBe(201);
    expect(res.body.feedback.rating).toBe(5);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'feedback_added' }));
  });

  test('GET /feedback lists feedback', async () => {
    setSession();
    query.mockResolvedValueOnce({ rows: [{ id: 3, establishment_name: 'Tasca', rating: 4 }] });
    const res = await request(app).get('/api/platform/feedback').set('x-session-token', 'valid');
    expect(res.status).toBe(200);
    expect(res.body.feedback).toHaveLength(1);
  });
});

describe('metrics', () => {
  test('GET /metrics returns aggregate metrics and plan breakdown', async () => {
    setSession();
    query
      .mockResolvedValueOnce({ rows: [{
        total_establishments: '5', active_establishments: '4', pilot_establishments: '1',
        suspended_subscriptions: '1', total_clients: '100', total_transactions: '500',
        total_revenue_usd: '1234.50', total_feedback: '3',
      }] })
      .mockResolvedValueOnce({ rows: [{ plan: 'free', count: '2' }, { plan: 'pro', count: '3' }] });

    const res = await request(app).get('/api/platform/metrics').set('x-session-token', 'valid');
    expect(res.status).toBe(200);
    expect(res.body.metrics.total_establishments).toBe(5);
    expect(res.body.metrics.total_revenue_usd).toBe(1234.5);
    expect(res.body.plans).toEqual(expect.arrayContaining([{ plan: 'pro', count: 3 }]));
  });
});