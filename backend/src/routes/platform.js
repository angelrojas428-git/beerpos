// Platform admin (super-admin) console API.
//
// Every route requires a staff session whose role is 'platform_admin'. Platform
// admins operate across establishments (their session has no establishment_id).
//
// Endpoints:
//   GET    /                          list establishments + aggregate metrics
//   POST   /                          onboard a new establishment (atomic: est + owner + rate + branding)
//   PATCH  /:id                        edit / suspend an establishment
//   GET    /:id/audit                  support: audit log for one establishment
//   POST   /:id/force-logout           support: revoke all staff sessions of an establishment
//   POST   /:id/clients/:clientId/rotate-token  support: rotate one client QR token
import { Router } from 'express';
import { pool, query } from '../db/pool.js';
import { requireStaffSession, requirePlatformAdmin } from '../middleware/auth.js';
import { auditLog } from '../lib/audit.js';
import { deleteSessionsByEstablishment } from '../lib/session.js';
import { hashPin, validatePin } from '../lib/pin.js';
import { generateAccessToken, hashAccessToken } from '../lib/token.js';
import {
  getSubscription,
  ensureSubscription,
  assignPlan,
  recordPayment,
  suspendSubscription,
  listSubscriptions,
  startPilot,
  endPilot,
} from '../lib/subscriptions.js';
import { listPlans, isKnownPlan } from '../lib/plans.js';

const router = Router();

// All platform routes require a platform admin.
router.use(requireStaffSession, requirePlatformAdmin);

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// List establishments with aggregate metrics.
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.id, e.name, e.owner_name, e.phone, e.beer_price_usd, e.active,
              e.logo_url, e.theme_color, e.secondary_color, e.created_at,
              (SELECT COUNT(*) FROM clients c WHERE c.establishment_id = e.id) AS clients_count,
              (SELECT COUNT(*) FROM staff s WHERE s.establishment_id = e.id AND s.active = true) AS staff_count,
              (SELECT COUNT(*) FROM transactions t WHERE t.establishment_id = e.id) AS transactions_count,
              (SELECT COALESCE(SUM(t.amount_usd), 0) FROM transactions t WHERE t.establishment_id = e.id) AS revenue_usd
         FROM establishments e
        ORDER BY e.id`
    );
    const establishments = rows.map((e) => ({
      ...e,
      clients_count: toInt(e.clients_count),
      staff_count: toInt(e.staff_count),
      transactions_count: toInt(e.transactions_count),
      revenue_usd: Number(e.revenue_usd) || 0,
    }));
    res.json({ ok: true, establishments });
  } catch (e) { next(e); }
});

// Onboard a new establishment: creates establishment + owner + exchange rate atomically.
router.post('/', async (req, res, next) => {
  const {
    name,
    owner_name,
    owner_pin,
    phone = null,
    beer_price_usd = 1.50,
    usd_to_ves = null,
    theme_color = '#0f172a',
    secondary_color = '#f59e0b',
  } = req.body || {};

  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ error: 'name is required (min 2 chars)' });
  }
  if (!owner_name || String(owner_name).trim().length < 2) {
    return res.status(400).json({ error: 'owner_name is required (min 2 chars)' });
  }
  if (owner_pin === undefined || owner_pin === null || owner_pin === '') {
    return res.status(400).json({ error: 'owner_pin is required' });
  }
  const policy = validatePin(owner_pin);
  if (!policy.ok) return res.status(400).json({ error: policy.error });
  if (usd_to_ves != null && (!Number.isFinite(Number(usd_to_ves)) || Number(usd_to_ves) <= 0)) {
    return res.status(400).json({ error: 'usd_to_ves must be a positive number' });
  }

  const hash = await hashPin(owner_pin);

  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');

    const estResult = await db.query(
      `INSERT INTO establishments (name, owner_name, phone, beer_price_usd, theme_color, secondary_color)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [String(name).trim(), String(owner_name).trim(), phone, beer_price_usd, theme_color, secondary_color]
    );
    const establishment = estResult.rows[0];

    await db.query(
      `INSERT INTO staff (establishment_id, name, pin, role) VALUES ($1, $2, $3, 'owner')`,
      [establishment.id, String(owner_name).trim(), hash]
    );

    if (usd_to_ves != null) {
      await db.query(
        `INSERT INTO exchange_rates (establishment_id, usd_to_ves) VALUES ($1, $2)`,
        [establishment.id, Number(usd_to_ves)]
      );
    }

    await db.query('COMMIT');

    await auditLog({
      establishmentId: establishment.id,
      action: 'platform_establishment_created',
      entityType: 'establishment',
      entityId: establishment.id,
      details: { name: establishment.name, owner_name: establishment.owner_name, by: 'platform_admin' },
      ipAddress: req.ip || null,
    });

    res.status(201).json({ ok: true, establishment });
  } catch (e) {
    if (db) { try { await db.query('ROLLBACK'); } catch { /* ignore */ } }
    next(e);
  } finally {
    if (db) db.release();
  }
});

// Edit / suspend an establishment (COALESCE: only provided fields are updated; false is honored).
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, owner_name, phone, beer_price_usd, logo_url, theme_color, secondary_color, active } = req.body || {};

    const { rows } = await query(
      `UPDATE establishments SET
         name = COALESCE($1, name),
         owner_name = COALESCE($2, owner_name),
         phone = COALESCE($3, phone),
         beer_price_usd = COALESCE($4, beer_price_usd),
         logo_url = COALESCE($5, logo_url),
         theme_color = COALESCE($6, theme_color),
         secondary_color = COALESCE($7, secondary_color),
         active = COALESCE($8, active)
       WHERE id = $9 RETURNING *`,
      [name ?? null, owner_name ?? null, phone ?? null, beer_price_usd ?? null, logo_url ?? null, theme_color ?? null, secondary_color ?? null, active ?? null, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Establishment not found' });

    await auditLog({
      establishmentId: rows[0].id,
      action: active === false ? 'platform_establishment_suspended' : 'platform_establishment_updated',
      entityType: 'establishment',
      entityId: rows[0].id,
      details: { fields: Object.keys(req.body || {}), by: 'platform_admin' },
      ipAddress: req.ip || null,
    });

    res.json({ ok: true, establishment: rows[0] });
  } catch (e) { next(e); }
});

// Support: audit log for one establishment.
router.get('/:id/audit', async (req, res, next) => {
  try {
    const { id } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows } = await query(
      `SELECT id, action, entity_type, entity_id, details, ip_address, staff_id, created_at
         FROM audit_log
        WHERE establishment_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );
    res.json({ ok: true, audit: rows });
  } catch (e) { next(e); }
});

// Support: revoke all staff sessions of an establishment (force logout).
router.post('/:id/force-logout', async (req, res, next) => {
  try {
    const { id } = req.params;
    const removed = await deleteSessionsByEstablishment(id);
    await auditLog({
      establishmentId: Number(id),
      action: 'platform_force_logout',
      entityType: 'establishment',
      entityId: Number(id),
      details: { removed_sessions: removed, by: 'platform_admin' },
      ipAddress: req.ip || null,
    });
    res.json({ ok: true, removed });
  } catch (e) { next(e); }
});

// Support: rotate one client's QR token (returns the new plaintext token once).
router.post('/:id/clients/:clientId/rotate-token', async (req, res, next) => {
  try {
    const { id, clientId } = req.params;
    const { rows } = await query(
      `SELECT id, full_name FROM clients WHERE id = $1 AND establishment_id = $2`,
      [clientId, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found in this establishment' });

    const newToken = generateAccessToken();
    await query(
      `UPDATE clients SET access_token = $1, token_expires_at = NULL WHERE id = $2`,
      [hashAccessToken(newToken), clientId]
    );

    await auditLog({
      establishmentId: Number(id),
      clientId: Number(clientId),
      action: 'platform_client_token_rotated',
      entityType: 'client',
      entityId: Number(clientId),
      details: { by: 'platform_admin' },
      ipAddress: req.ip || null,
    });

    // Plaintext token is returned once (like registration) for QR regeneration.
    res.json({ ok: true, client_id: Number(clientId), access_token: newToken });
  } catch (e) { next(e); }
});

// --- Billing / subscriptions ---

// Plan catalog.
router.get('/plans', async (_req, res, next) => {
  try {
    res.json({ ok: true, plans: listPlans() });
  } catch (e) { next(e); }
});

// List all subscriptions with establishment info.
router.get('/subscriptions', async (_req, res, next) => {
  try {
    const subscriptions = await listSubscriptions();
    res.json({ ok: true, subscriptions });
  } catch (e) { next(e); }
});

// Assign (or change) the plan of an establishment.
router.put('/:id/subscription', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { plan } = req.body || {};
    if (!isKnownPlan(plan)) {
      return res.status(400).json({ error: `Unknown plan. Valid: ${listPlans().map((p) => p.id).join(', ')}` });
    }
    const subscription = await assignPlan(id, plan);
    res.json({ ok: true, subscription });
  } catch (e) { next(e); }
});

// Record a payment (manual verification): extends the period and reactivates.
router.post('/:id/payment', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { months = 1, payment_method = 'manual', amount_usd, reference } = req.body || {};
    const result = await recordPayment(id, {
      months,
      payment_method,
      amount_usd,
      reference,
      staffId: req.staff?.id,
      ip: req.ip || null,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

// Manually suspend an establishment's subscription (non-payment / admin action).
router.post('/:id/suspend', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason = 'manual' } = req.body || {};
    const result = await suspendSubscription(id, reason, { by: 'platform_admin', staffId: req.staff?.id, ip: req.ip || null });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

// --- Pilots / free trials ---

// Start (or extend) a free pilot for an establishment.
router.post('/:id/pilot', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { trial_days } = req.body || {};
    const subscription = await startPilot(id, { trialDays: trial_days, staffId: req.staff?.id, ip: req.ip || null });
    res.json({ ok: true, subscription });
  } catch (e) { next(e); }
});

// End a pilot early.
router.delete('/:id/pilot', async (req, res, next) => {
  try {
    const { id } = req.params;
    const subscription = await endPilot(id, { staffId: req.staff?.id, ip: req.ip || null });
    res.json({ ok: true, subscription });
  } catch (e) { next(e); }
});

// --- Feedback (pilots) ---

// Capture feedback for an establishment (rating + comment).
router.post('/:id/feedback', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rating, comment = null, category = 'general', author = null } = req.body || {};
    const r = rating != null ? parseInt(rating, 10) : null;
    if (r == null || r < 1 || r > 5) {
      return res.status(400).json({ error: 'rating must be an integer 1-5' });
    }
    const { rows } = await query(
      `INSERT INTO feedback (establishment_id, rating, category, comment, author)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, r, category, comment, author]
    );
    await auditLog({
      establishmentId: Number(id),
      action: 'feedback_added',
      entityType: 'feedback',
      entityId: rows[0].id,
      details: { rating: r, category, by: 'platform_admin' },
      ipAddress: req.ip || null,
    });
    res.status(201).json({ ok: true, feedback: rows[0] });
  } catch (e) { next(e); }
});

// List feedback (optionally filtered by establishment).
router.get('/feedback', async (req, res, next) => {
  try {
    const estId = req.query.establishment_id;
    const params = [];
    let sql = `SELECT f.*, e.name AS establishment_name
                 FROM feedback f
                 JOIN establishments e ON e.id = f.establishment_id`;
    if (estId) { params.push(estId); sql += ` WHERE f.establishment_id = $1`; }
    sql += ` ORDER BY f.created_at DESC LIMIT 200`;
    const { rows } = await query(sql, params);
    res.json({ ok: true, feedback: rows });
  } catch (e) { next(e); }
});

// --- Aggregate metrics (dashboard) ---

router.get('/metrics', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*) FROM establishments) AS total_establishments,
         (SELECT COUNT(*) FROM establishments WHERE active = true) AS active_establishments,
         (SELECT COUNT(*) FROM subscriptions WHERE is_pilot = true) AS pilot_establishments,
         (SELECT COUNT(*) FROM subscriptions WHERE status = 'suspended') AS suspended_subscriptions,
         (SELECT COUNT(*) FROM clients) AS total_clients,
         (SELECT COUNT(*) FROM transactions) AS total_transactions,
         (SELECT COALESCE(SUM(amount_usd), 0) FROM transactions) AS total_revenue_usd,
         (SELECT COUNT(*) FROM feedback) AS total_feedback`
    );
    const plans = await query(`SELECT plan, COUNT(*)::int AS count FROM subscriptions GROUP BY plan ORDER BY plan`);
    const m = rows[0] || {};
    res.json({
      ok: true,
      metrics: {
        total_establishments: toInt(m.total_establishments),
        active_establishments: toInt(m.active_establishments),
        pilot_establishments: toInt(m.pilot_establishments),
        suspended_subscriptions: toInt(m.suspended_subscriptions),
        total_clients: toInt(m.total_clients),
        total_transactions: toInt(m.total_transactions),
        total_revenue_usd: Number(m.total_revenue_usd) || 0,
        total_feedback: toInt(m.total_feedback),
      },
      plans: plans.rows.map((p) => ({ plan: p.plan, count: toInt(p.count) })),
    });
  } catch (e) { next(e); }
});

export default router;