// Cron jobs for fast sale expiration
import { query } from '../db/pool.js';
import { emitToRoom } from './socket.js';
import { broadcastSse } from '../routes/events.js';
import { runBackup } from './backup.js';
import { sweepExpiredSubscriptions } from './subscriptions.js';

function notify(event, data, establishmentId) {
  emitToRoom(event, data, establishmentId);
  broadcastSse(event, data, establishmentId);
}

export async function expireFastRedemptions(establishmentId = null) {
  try {
    const params = [];
    let sql = `SELECT id, establishment_id, code, quantity FROM fast_redemptions
               WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at < NOW()`;
    if (establishmentId) { params.push(establishmentId); sql += ` AND establishment_id = $1`; }
    const { rows: expired } = await query(sql, params);
    if (expired.length === 0) return 0;

    const ids = expired.map((_, i) => `$${i + 2}`).join(',');
    await query(
      `UPDATE fast_redemptions SET status = 'EXPIRED' WHERE id IN (${ids})`,
      expired.map((e) => e.id)
    );

    for (const e of expired) {
      notify('fast_expired', { id: e.id, code: e.code, quantity: e.quantity }, e.establishment_id);
    }
    return expired.length;
  } catch (e) {
    console.error('expireFastRedemptions error', e.message);
    return 0;
  }
}

// Auto-expire client orders that passed their expires_at
export async function expireClientOrders(establishmentId = null) {
  try {
    const params = [];
    let sql = `SELECT id, establishment_id, client_id, quantity FROM client_orders
               WHERE status = 'SOLICITADO' AND expires_at IS NOT NULL AND expires_at < NOW()`;
    if (establishmentId) { params.push(establishmentId); sql += ` AND establishment_id = $1`; }
    const { rows: expired } = await query(sql, params);
    if (expired.length === 0) return 0;

    const ids = expired.map((_, i) => `$${i + 2}`).join(',');
    await query(
      `UPDATE client_orders SET status = 'EXPIRADO' WHERE id IN (${ids})`,
      expired.map((e) => e.id)
    );

    for (const e of expired) {
      notify('client_order_expired', {
        order_id: e.id,
        client_id: e.client_id,
        establishment_id: e.establishment_id,
        quantity: e.quantity,
        status: 'EXPIRADO'
      }, e.establishment_id);
    }
    return expired.length;
  } catch (e) {
    console.error('expireClientOrders error', e.message);
    return 0;
  }
}

export function startFastSaleExpiryCron() {
  setInterval(() => {
    expireFastRedemptions();
    expireClientOrders();
  }, 5 * 60 * 1000);
  console.log('Fast sale expiry cron started (every 5 min)');
  console.log('Client order expiry cron started (every 5 min)');
}

// Daily database backup at 2:00 AM
export function startBackupCron() {
  const runDailyBackup = async () => {
    try {
      const result = await runBackup();
      console.log(`[backup] Daily backup completed: ${result.results.length} tables`);
    } catch (e) {
      console.error('[backup] Daily backup failed:', e.message);
    }
  };

  // Calculate time until next 2:00 AM
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(2, 0, 0, 0);
  if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
  const msUntilNextRun = nextRun.getTime() - now.getTime();

  setTimeout(() => {
    runDailyBackup();
    setInterval(runDailyBackup, 24 * 60 * 60 * 1000);
  }, msUntilNextRun);

  console.log(`[backup] Daily backup scheduled at 02:00 (in ${Math.round(msUntilNextRun / 1000 / 60)} min)`);
}

// Billing: auto-suspend establishments whose subscription lapsed (non-payment).
export function startSubscriptionCron() {
  const run = async () => {
    try {
      await sweepExpiredSubscriptions();
    } catch (e) {
      console.error('[billing] Subscription sweep failed:', e.message);
    }
  };

  // Run once shortly after boot to catch anything already expired, then every 6h.
  const initial = setTimeout(run, 30 * 1000);
  if (typeof initial.unref === 'function') initial.unref();
  const timer = setInterval(run, 6 * 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[billing] Subscription sweep scheduled (every 6h)');
}