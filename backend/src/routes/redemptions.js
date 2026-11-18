import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { pool, query } from '../db/pool.js';
import { getLatestRate } from '../lib.js';
import { emitToRoom } from '../lib/socket.js';
import { broadcastSse } from './events.js';
import { fastSaleLimiter, redeemLimiter } from '../middleware/rateLimit.js';
import { requireStaffSession, requireStaffSessionForEst } from '../middleware/auth.js';
import { config } from '../lib/config.js';

const router = Router();

// Helper to notify both Socket.IO and SSE
function notify(event, data, establishmentId) {
  emitToRoom(event, data, establishmentId);
  broadcastSse(event, data, establishmentId);
}

// Create fast sale (generates 3-digit code)
router.post('/fast', requireStaffSession, requireStaffSessionForEst, fastSaleLimiter, async (req, res, next) => {
  const { establishment_id, quantity, request_id: requestId } = req.body || {};
  const qty = Number(quantity);
  if (!establishment_id || !Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'establishment_id and a positive integer quantity are required' });
  }
  if (requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    return res.status(400).json({ error: 'request_id must be a UUID' });
  }
  const session = req.session;

  let db;
  let transactionStarted = false;
  try {
    db = await pool.connect();
    await db.query('BEGIN');
    transactionStarted = true;

    if (requestId) {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [requestId]);
      const existing = await db.query(
        `SELECT r.*, t.amount_usd, t.amount_ves
         FROM fast_redemptions r
         JOIN transactions t ON t.request_id = r.request_id
         WHERE r.request_id = $1`,
        [requestId]
      );
      if (existing.rows[0]) {
        await db.query('COMMIT');
        transactionStarted = false;
        return res.json({
          redemption: existing.rows[0],
          amount_usd: existing.rows[0].amount_usd,
          amount_ves: existing.rows[0].amount_ves,
          duplicate: true
        });
      }
    }

    // Generate unique pending code for this establishment
    let code;
    let attempts = 0;
    while (true) {
      code = String(randomInt(0, 1000)).padStart(3, '0');
      const exists = await db.query(
        `SELECT 1 FROM fast_redemptions WHERE establishment_id = $1 AND code = $2 AND status = 'PENDING'`,
        [establishment_id, code]
      );
      if (exists.rowCount === 0) break;
      attempts++;
      if (attempts > 20) {
        await db.query('ROLLBACK');
        transactionStarted = false;
        return res.status(500).json({ error: 'Unable to generate unique code, try again' });
      }
    }

    const expiresAt = new Date(Date.now() + config.fastSaleExpiryMinutes * 60 * 1000);
    const frRes = await db.query(
      `INSERT INTO fast_redemptions (establishment_id, code, quantity, status, expires_at)
       VALUES ($1,$2,$3,'PENDING',$4) RETURNING *`,
      [establishment_id, code, qty, expiresAt]
    );
    if (requestId) {
      await db.query('UPDATE fast_redemptions SET request_id = $1 WHERE id = $2', [requestId, frRes.rows[0].id]);
      frRes.rows[0].request_id = requestId;
    }

    const estRes = await db.query('SELECT beer_price_usd FROM establishments WHERE id = $1', [establishment_id]);
    const price = Number(estRes.rows[0]?.beer_price_usd || 0);
    const amountUsd = (price * qty).toFixed(2);
    const rate = await getLatestRate(establishment_id);
    const amountVes = (Number(amountUsd) * (rate ? Number(rate.usd_to_ves) : 0)).toFixed(2);

    await db.query(
      `INSERT INTO transactions
       (establishment_id, client_id, staff_id, transaction_type, quantity,
        amount_usd, amount_ves, payment_method, request_id)
       VALUES ($1,NULL,$2,'FAST_SALE',$3,$4,$5,'cash',$6)`,
      [establishment_id, session?.staff?.id || null, qty, amountUsd, amountVes, requestId || null]
    );

    await db.query('COMMIT');
    transactionStarted = false;
    notify('fast_sale', { redemption: frRes.rows[0], amount_usd: amountUsd, amount_ves: amountVes }, establishment_id);
    res.status(201).json({ redemption: frRes.rows[0], amount_usd: amountUsd, amount_ves: amountVes });
  } catch (e) {
    if (transactionStarted) await db.query('ROLLBACK');
    next(e);
  } finally {
    if (db) db.release();
  }
});

// List pending fast redemptions
router.get('/fast', requireStaffSession, async (req, res, next) => {
  try {
    const { establishment_id } = req.query;
    if (!establishment_id) return res.status(400).json({ error: 'establishment_id required' });
    if (Number(req.establishmentId) !== Number(establishment_id)) {
      return res.status(403).json({ error: 'Forbidden: session does not belong to this establishment' });
    }
    const { rows } = await query(
      `SELECT * FROM fast_redemptions
       WHERE establishment_id = $1 AND status = 'PENDING'
       ORDER BY created_at DESC`,
      [establishment_id]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// Complete (dispatch) a fast redemption by id
router.post('/fast/:id/dispatch', requireStaffSession, redeemLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const session = req.session;
    const { rows } = await query(
      `UPDATE fast_redemptions
       SET status = 'COMPLETED', dispatched_at = NOW(), dispatched_by_staff_id = $2
       WHERE id = $1 AND status = 'PENDING'
         AND establishment_id = $3
       RETURNING *`,
      [id, session.staff?.id || null, session.establishment_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Redemption not found or already completed' });
    notify('fast_dispatch', { redemption: rows[0] }, rows[0].establishment_id);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Expire old pending redemptions (can be called periodically)
router.post('/fast/expire', requireStaffSession, redeemLimiter, async (req, res, next) => {
  try {
    const { establishment_id } = req.body || {};
    const { expireFastRedemptions } = await import('../lib/cron.js');
    // Only expire for the staff's establishment unless owner
    const estId = establishment_id && Number(req.establishmentId) === Number(establishment_id)
      ? establishment_id
      : req.establishmentId;
    res.json({ expired: await expireFastRedemptions(estId || null) });
  } catch (e) { next(e); }
});

export default router;