// Subscription lifecycle: billing state per establishment.
//
// Status model (subscriptions.status):
//   active     -> current_period_end in the future (or within grace), service enabled
//   suspended  -> establishments.active = FALSE and staff sessions revoked
//   canceled   -> soft cancel
//
// Automatic suspension for non-payment runs from the cron (sweepExpiredSubscriptions),
// which flips status to 'suspended', sets establishments.active = FALSE and force-logs-out
// staff (they must log in again, and login is blocked while active = FALSE).
import { pool, query } from '../db/pool.js';
import { auditLog } from './audit.js';
import { deleteSessionsByEstablishment } from './session.js';
import { DEFAULT_PLAN, GRACE_PERIOD_DAYS, getPlan, isKnownPlan } from './plans.js';

/** Fetch a subscription row for an establishment, or null. */
export async function getSubscription(establishmentId) {
  const { rows } = await query(`SELECT * FROM subscriptions WHERE establishment_id = $1`, [establishmentId]);
  return rows[0] || null;
}

/** Create the subscription row if missing (free plan, active). Returns the row. */
export async function ensureSubscription(establishmentId, plan = DEFAULT_PLAN) {
  await query(
    `INSERT INTO subscriptions (establishment_id, plan, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (establishment_id) DO NOTHING`,
    [establishmentId, isKnownPlan(plan) ? plan : DEFAULT_PLAN]
  );
  return getSubscription(establishmentId);
}

/** Change the plan of an existing (or new) subscription. Returns the row. */
export async function assignPlan(establishmentId, plan) {
  if (!isKnownPlan(plan)) throw new Error('Unknown plan: ' + plan);
  const { rows } = await query(
    `INSERT INTO subscriptions (establishment_id, plan, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (establishment_id) DO UPDATE SET plan = EXCLUDED.plan, updated_at = NOW()
     RETURNING *`,
    [establishmentId, plan]
  );
  await auditLog({
    establishmentId: Number(establishmentId),
    action: 'subscription_plan_changed',
    entityType: 'subscription',
    entityId: rows[0].id,
    details: { plan, by: 'platform_admin' },
  });
  return rows[0];
}

/**
 * Record a payment (manual verification by the platform admin): extends the period,
 * activates the subscription and re-enables the establishment.
 * @param {number} establishmentId
 * @param {{months?:number, payment_method?:string, amount_usd?:number, reference?:string, staffId?:number, ip?:string}} opts
 */
export async function recordPayment(establishmentId, opts = {}) {
  const months = Math.max(1, parseInt(opts.months, 10) || 1);
  const paymentMethod = opts.payment_method || 'manual';
  const amountUsd = opts.amount_usd != null ? Number(opts.amount_usd) : getPlan((await getSubscription(establishmentId))?.plan).priceUsd || 0;
  const reference = opts.reference || null;

  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    const sub = await db.query(
      `INSERT INTO subscriptions (establishment_id, plan, status, current_period_end)
       VALUES ($1, $2, 'active', NOW() + ($3 * INTERVAL '1 month'))
       ON CONFLICT (establishment_id) DO UPDATE SET
         status = 'active',
         current_period_end = GREATEST(COALESCE(subscriptions.current_period_end, NOW()), NOW()) + ($3 * INTERVAL '1 month'),
         payment_method = $4,
         amount_usd = $5,
         last_paid_at = NOW(),
         grace_until = NULL,
         is_pilot = FALSE,
         updated_at = NOW()
       RETURNING *`,
      [establishmentId, DEFAULT_PLAN, months, paymentMethod, amountUsd]
    );

    await db.query(`UPDATE establishments SET active = TRUE WHERE id = $1`, [establishmentId]);

    await db.query('COMMIT');
    const subscription = sub.rows[0];

    await auditLog({
      establishmentId: Number(establishmentId),
      staffId: opts.staffId ?? null,
      action: 'subscription_payment_recorded',
      entityType: 'subscription',
      entityId: subscription.id,
      details: { months, payment_method: paymentMethod, amount_usd: amountUsd, reference, by: 'platform_admin' },
      ipAddress: opts.ip || null,
    });

    return { subscription, establishment_active: true };
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    db.release();
  }
}

/**
 * Suspend a subscription for non-payment (or manually): status = suspended,
 * establishment disabled, staff sessions revoked.
 */
export async function suspendSubscription(establishmentId, reason = 'non_payment', opts = {}) {
  const { rowCount } = await query(
    `UPDATE subscriptions SET status = 'suspended', grace_until = NULL, updated_at = NOW()
      WHERE establishment_id = $1`,
    [establishmentId]
  );
  await query(`UPDATE establishments SET active = FALSE WHERE id = $1`, [establishmentId]);
  const removed = await deleteSessionsByEstablishment(establishmentId);

  await auditLog({
    establishmentId: Number(establishmentId),
    staffId: opts.staffId ?? null,
    action: 'subscription_suspended',
    entityType: 'subscription',
    entityId: Number(establishmentId),
    details: { reason, removed_sessions: removed, by: opts.by || 'cron' },
    ipAddress: opts.ip || null,
  });

  return { suspended: rowCount > 0, removed_sessions: removed };
}

/**
 * Auto-suspend subscriptions whose paid period (plus grace) has elapsed, and
 * pilots whose trial ended without a payment.
 * Intended to be called by the cron. Returns the number of subscriptions suspended.
 */
export async function sweepExpiredSubscriptions(opts = {}) {
  const { rows } = await query(
    `SELECT establishment_id FROM subscriptions
      WHERE status = 'active'
        AND (
          (current_period_end IS NOT NULL AND current_period_end < NOW() - ($1 * INTERVAL '1 day'))
          OR
          (is_pilot = TRUE AND trial_ends_at IS NOT NULL AND trial_ends_at < NOW() AND last_paid_at IS NULL)
        )`,
    [GRACE_PERIOD_DAYS]
  );
  let suspended = 0;
  for (const r of rows) {
    await suspendSubscription(r.establishment_id, 'non_payment', { by: 'cron' });
    suspended += 1;
  }
  if (opts.log !== false && suspended > 0) {
    console.log(`[billing] Auto-suspended ${suspended} establishment(s) for non-payment / expired trial.`);
  }
  return suspended;
}

/**
 * Start (or extend) a free pilot/trial for an establishment.
 * @param {number} establishmentId
 * @param {{trialDays?:number, staffId?:number, ip?:string}} opts
 */
export async function startPilot(establishmentId, opts = {}) {
  const trialDays = Math.max(1, parseInt(opts.trialDays, 10) || 14);

  const { rows } = await query(
    `INSERT INTO subscriptions (establishment_id, plan, status, is_pilot, trial_ends_at)
     VALUES ($1, $2, 'active', TRUE, NOW() + ($3 * INTERVAL '1 day'))
     ON CONFLICT (establishment_id) DO UPDATE SET
       status = 'active',
       is_pilot = TRUE,
       trial_ends_at = NOW() + ($3 * INTERVAL '1 day'),
       updated_at = NOW()
     RETURNING *`,
    [establishmentId, DEFAULT_PLAN, trialDays]
  );
  await query(`UPDATE establishments SET active = TRUE WHERE id = $1`, [establishmentId]);

  await auditLog({
    establishmentId: Number(establishmentId),
    staffId: opts.staffId ?? null,
    action: 'pilot_started',
    entityType: 'subscription',
    entityId: rows[0].id,
    details: { trial_days: trialDays, by: 'platform_admin' },
    ipAddress: opts.ip || null,
  });

  return rows[0];
}

/** End a pilot early (keeps the subscription, clears the pilot flags). */
export async function endPilot(establishmentId, opts = {}) {
  const { rows } = await query(
    `UPDATE subscriptions SET is_pilot = FALSE, trial_ends_at = NULL, updated_at = NOW()
      WHERE establishment_id = $1
      RETURNING *`,
    [establishmentId]
  );
  await auditLog({
    establishmentId: Number(establishmentId),
    staffId: opts.staffId ?? null,
    action: 'pilot_ended',
    entityType: 'subscription',
    entityId: rows[0]?.id ?? Number(establishmentId),
    details: { by: 'platform_admin' },
    ipAddress: opts.ip || null,
  });
  return rows[0] || null;
}

/** List all subscriptions with establishment info (for the console). */
export async function listSubscriptions() {
  const { rows } = await query(
    `SELECT s.id, s.establishment_id, s.plan, s.status, s.current_period_end,
            s.payment_method, s.amount_usd, s.currency, s.last_paid_at, s.grace_until,
            s.is_pilot, s.trial_ends_at,
            e.name AS establishment_name, e.active AS establishment_active
       FROM subscriptions s
       JOIN establishments e ON e.id = s.establishment_id
      ORDER BY s.id`
  );
  return rows;
}