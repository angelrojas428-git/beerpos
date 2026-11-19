import { Router } from 'express';
import { pool, query } from '../db/pool.js';
import crypto from 'crypto';
import { generateAccessToken, hashAccessToken } from '../lib/token.js';
import { redeemLimiter, tokenRotationLimiter, clientLimiter } from '../middleware/rateLimit.js';
import { requireStaffSession, requireStaffSessionForEst } from '../middleware/auth.js';
import { getLatestRate } from '../lib.js';
import { emitToRoom } from '../lib/socket.js';
import { broadcastSse } from './events.js';
import { auditLog } from '../lib/audit.js';

const router = Router();

// Register client (express) with duplicate document_id and phone validation
router.post('/', requireStaffSession, requireStaffSessionForEst, async (req, res, next) => {
  const { establishment_id, full_name, document_id, phone } = req.body || {};
  if (!establishment_id || !full_name || !document_id || !phone) {
    return res.status(400).json({ error: 'establishment_id, full_name, document_id and phone are required' });
  }
  if (typeof full_name !== 'string' || full_name.trim().length < 2) {
    return res.status(400).json({ error: 'full_name must be at least 2 characters' });
  }
  if (typeof document_id !== 'string' || document_id.trim().length < 5) {
    return res.status(400).json({ error: 'document_id must be at least 5 characters' });
  }
  if (typeof phone !== 'string' || !/^\d{7,15}$/.test(phone.trim())) {
    return res.status(400).json({ error: 'phone must be 7-15 digits' });
  }
  const cleanPhone = phone.trim();
  const cleanDoc = document_id.trim();
  const cleanName = full_name.trim();

  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');
    // Check for duplicate phone within the same establishment (excluding current document_id)
    const dupPhone = await db.query(
      `SELECT 1 FROM clients WHERE establishment_id = $1 AND phone = $2 AND document_id <> $3`,
      [establishment_id, cleanPhone, cleanDoc]
    );
    if (dupPhone.rowCount > 0) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Ya existe un cliente con ese nÃºmero de telÃ©fono en este establecimiento.' });
    }
    const access_token = generateAccessToken();
    const access_token_hash = hashAccessToken(access_token);
    const { rows } = await db.query(
      `INSERT INTO clients (establishment_id, full_name, document_id, phone, access_token)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (establishment_id, document_id)
       DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, access_token = EXCLUDED.access_token
       RETURNING *`,
      [establishment_id, cleanName, cleanDoc, cleanPhone, access_token_hash]
    );
    await db.query('COMMIT');
    // Never expose the stored hash; return the plaintext token once for QR generation.
    const client = rows[0];
    delete client.access_token;
    res.status(201).json({ ...client, access_token });
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    next(e);
  } finally {
    if (db) db.release();
  }
});

router.get('/token/:token', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.establishment_id, c.full_name, c.current_balance,
              e.name AS establishment_name, e.beer_price_usd, e.logo_url,
              e.theme_color, e.secondary_color
       FROM clients c
       JOIN establishments e ON e.id = c.establishment_id
       WHERE c.access_token = $1 AND (c.token_expires_at IS NULL OR c.token_expires_at > NOW())`,
      [hashAccessToken(req.params.token)]
    );
    if (!rows[0]) return res.status(401).json({ error: 'QR invÃ¡lido o expirado.' });
    const client = rows[0];
    client.exchange_rate = await getLatestRate(client.establishment_id);
    res.json(client);
  } catch (e) { next(e); }
});

router.post('/token/:token/redeem', redeemLimiter, async (req, res, next) => {
  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive integer' });
  }

  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');
    const { rows } = await db.query(
       `SELECT c.id, c.establishment_id, COALESCE(c.current_balance, 0) AS current_balance, c.access_token
        FROM clients c
        WHERE c.access_token = $1 AND (c.token_expires_at IS NULL OR c.token_expires_at > NOW())
        FOR UPDATE`,
      [hashAccessToken(req.params.token)]
    );
    const client = rows[0];
    if (!client) {
      await db.query('ROLLBACK');
      return res.status(401).json({ error: 'QR invÃ¡lido o expirado.' });
    }
    if (client.current_balance < quantity) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Saldo insuficiente.' });
    }

    const update = await db.query(
      `UPDATE clients SET current_balance = COALESCE(current_balance, 0) - $1
       WHERE id = $2 RETURNING current_balance`,
      [quantity, client.id]
    );
    await db.query(
      `INSERT INTO transactions
       (establishment_id, client_id, transaction_type, quantity, amount_usd, amount_ves, payment_method)
       VALUES ($1, $2, 'REDEMPTION', $3, 0, 0, 'balance')`,
      [client.establishment_id, client.id, quantity]
    );
    await db.query('COMMIT');

    const result = {
      client_id: client.id,
      establishment_id: client.establishment_id,
      redeemed: quantity,
      current_balance: update.rows[0].current_balance
    };
    emitToRoom('client_redeem', result, client.establishment_id);
    // Target the SSE stream by client id (tokens are hashed at rest, never used as a channel key).
    broadcastSse('client_redeem', result, null, client.id);

    await auditLog({
      establishmentId: client.establishment_id,
      clientId: client.id,
      action: 'client_redeem',
      entityType: 'client',
      entityId: client.id,
      details: { redeemed: quantity, current_balance: update.rows[0].current_balance },
      ipAddress: req.ip || null,
    });

    res.json(result);
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    next(e);
  } finally {
    if (db) db.release();
  }
});

router.post('/:id/charge-combo', requireStaffSession, async (req, res, next) => {
  const quantity = Number(req.body?.quantity);
  if (!Number.isInteger(quantity) || quantity === 0) {
    return res.status(400).json({ error: 'quantity must be a non-zero integer' });
  }

  const session = req.session;

  let db;
  let transactionStarted = false;
  try {
    db = await pool.connect();
    await db.query('BEGIN');
    transactionStarted = true;
    const clientResult = await db.query(
      `SELECT c.id, c.establishment_id, c.full_name,
              COALESCE(c.current_balance, 0) AS current_balance, e.beer_price_usd
       FROM clients c
       JOIN establishments e ON e.id = c.establishment_id
       WHERE c.id = $1
       FOR UPDATE OF c`,
      [req.params.id]
    );
    const client = clientResult.rows[0];
    if (!client) {
      await db.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Client not found' });
    }
    if (Number(session.establishment_id) !== Number(client.establishment_id)) {
      await db.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ error: 'Staff session belongs to another establishment' });
    }

    const newBalance = Number(client.current_balance || 0) + quantity;
    if (newBalance < 0) {
      await db.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'No se puede descontar mÃ¡s cervezas de las que el cliente tiene en saldo' });
    }

    const rateResult = await db.query(
      `SELECT usd_to_ves FROM exchange_rates
       WHERE establishment_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [client.establishment_id]
    );
    const amountUsd = (Number(client.beer_price_usd || 0) * quantity).toFixed(2);
    const amountVes = (
      Number(amountUsd) * Number(rateResult.rows[0]?.usd_to_ves || 0)
    ).toFixed(2);
    const balanceResult = await db.query(
      `UPDATE clients SET current_balance = $1
       WHERE id = $2 RETURNING current_balance`,
      [newBalance, client.id]
    );
    if (quantity > 0) {
      await db.query(
        `UPDATE clients SET loyalty_points = COALESCE(loyalty_points, 0) + $1,
           loyalty_tier = CASE
             WHEN COALESCE(loyalty_points,0) + $1 >= 200 THEN 'oro'
             WHEN COALESCE(loyalty_points,0) + $1 >= 50 THEN 'plata'
             ELSE 'bronce'
           END
         WHERE id = $2`,
        [quantity, client.id]
      );
    }
    await db.query(
      `INSERT INTO transactions
       (establishment_id, client_id, staff_id, transaction_type, quantity,
        amount_usd, amount_ves, payment_method)
       VALUES ($1, $2, $3, 'COMBO_PURCHASE', $4, $5, $6, $7)`,
      [
        client.establishment_id,
        client.id,
        session?.staff?.id || null,
        quantity,
        amountUsd,
        amountVes,
        req.body.payment_method || 'cash'
      ]
    );
    await db.query('COMMIT');
    transactionStarted = false;

    await auditLog({
      establishmentId: client.establishment_id,
      staffId: session?.staff?.id || null,
      clientId: client.id,
      action: 'client_charge_combo',
      entityType: 'client',
      entityId: client.id,
      details: { quantity, new_balance: balanceResult.rows[0].current_balance },
      ipAddress: req.ip || null,
    });

    const updatedClient = {
      id: client.id,
      establishment_id: client.establishment_id,
      full_name: client.full_name,
      current_balance: balanceResult.rows[0].current_balance
    };
    const event = { client: updatedClient };
    emitToRoom('client_balance', event, client.establishment_id);
    broadcastSse('client_balance', event, client.establishment_id);
    res.json({ client: updatedClient, amount_usd: amountUsd, amount_ves: amountVes });
  } catch (e) {
    if (db && transactionStarted) await db.query('ROLLBACK');
    next(e);
  } finally {
    if (db) db.release();
  }
});

// Rotate client access token
router.post('/:id/rotate-token', requireStaffSession, tokenRotationLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const newToken = generateAccessToken();
    const newHash = hashAccessToken(newToken);
    const { rows } = await query(
      `UPDATE clients SET access_token = $1
       WHERE id = $2 AND establishment_id = $3
       RETURNING id, full_name, current_balance, token_expires_at`,
      [newHash, id, req.establishmentId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true, access_token: newToken, client: rows[0] });
  } catch (e) { next(e); }
});

// Get or generate verification code for client (displayed on client's screen for bartender verification)
router.get('/token/:token/verification-code', async (req, res, next) => {
  try {
    const { token } = req.params;
    const now = new Date();
    const { rows } = await query(
      `SELECT id, verification_code, verification_code_expires_at
       FROM clients
       WHERE access_token = $1 AND (token_expires_at IS NULL OR token_expires_at > NOW())`,
      [hashAccessToken(token)]
    );
    const client = rows[0];
    if (!client) return res.status(401).json({ error: 'QR invÃ¡lido o expirado.' });

    // Solo generar cÃ³digo nuevo si el actual expirÃ³ o no existe
    // Esto evita que mÃºltiples pestaÃ±as/dispositivos se sobrescriban mutuamente
    const needsNew = !client.verification_code ||
      !client.verification_code_expires_at ||
      new Date(client.verification_code_expires_at) <= now;

    let code = client.verification_code;
    let expiresAt = client.verification_code_expires_at;
    if (needsNew) {
      code = String(crypto.randomInt(1000, 10000)); // 4 digits, cryptographically secure
      expiresAt = new Date(Date.now() + 60 * 1000); // 60 seconds
      await query(
        `UPDATE clients SET verification_code = $1, verification_code_expires_at = $2 WHERE id = $3`,
        [code, expiresAt, client.id]
      );
    }

    res.json({ code, expires_at: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt });
  } catch (e) { next(e); }
});

// Verify client verification code (bartender enters code shown on client's screen)
router.post('/token/:token/verification-code/verify', async (req, res, next) => {
  try {
    const { token } = req.params;
    const { code } = req.body || {};
    if (!code || !/^\d{4}$/.test(String(code))) {
      return res.status(400).json({ error: 'CÃ³digo de verificaciÃ³n de 4 dÃ­gitos requerido' });
    }
    const now = new Date();
    const { rows } = await query(
      `SELECT id, establishment_id, full_name, current_balance
       FROM clients
       WHERE access_token = $1
         AND verification_code = $2
         AND verification_code_expires_at > $3
         AND (token_expires_at IS NULL OR token_expires_at > NOW())`,
      [hashAccessToken(token), String(code), now]
    );
    if (!rows[0]) return res.status(401).json({ error: 'CÃ³digo de verificaciÃ³n invÃ¡lido o expirado' });
    res.json({ ok: true, client: rows[0] });
  } catch (e) { next(e); }
});

// Set token expiration (days)
router.post('/:id/token-expire', requireStaffSession, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { days } = req.body;
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 365) {
      return res.status(400).json({ error: 'days must be an integer between 1 and 365' });
    }
    const { rows } = await query(
      `UPDATE clients SET token_expires_at = NOW() + ($1 * INTERVAL '1 day')
       WHERE id = $2 AND establishment_id = $3
       RETURNING id, token_expires_at`,
      [d, id, req.establishmentId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// List clients with token info (staff only â€” access_token exposed only to authenticated staff)
router.get('/', requireStaffSession, async (req, res, next) => {
  try {
    const { establishment_id, search } = req.query;
    if (!establishment_id) return res.status(400).json({ error: 'establishment_id required' });
    if (Number(req.establishmentId) !== Number(establishment_id)) {
      return res.status(403).json({ error: 'Forbidden: session does not belong to this establishment' });
    }
    const params = [establishment_id];
    // Do not expose tokens in bulk. Staff fetches a fresh token on demand via /:id/rotate-token
    // (only when they need to show/copy a client's QR).
    let sql = `SELECT id, full_name, document_id, phone, current_balance, token_expires_at, created_at,
                      credit_limit_usd, credit_balance_usd, credit_hold_reason, loyalty_points, loyalty_tier
               FROM clients WHERE establishment_id = $1`;
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (full_name ILIKE $${params.length} OR document_id ILIKE $${params.length} OR phone ILIKE $${params.length})`;
    }
    sql += ' ORDER BY created_at DESC LIMIT 100';
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// Purchase history for a client (staff only)
router.get('/:id/history', requireStaffSession, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { date_from, date_to } = req.query;
    const client = await query('SELECT id, establishment_id FROM clients WHERE id = $1', [id]);
    if (!client.rows[0]) return res.status(404).json({ error: 'Client not found' });
    if (Number(client.rows[0].establishment_id) !== Number(req.establishmentId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const params = [id];
    let dateCond = '';
    if (date_from && date_to) {
      params.push(date_from, date_to);
      dateCond = ` AND created_at::date BETWEEN $2 AND $3`;
    } else if (date_from) {
      params.push(date_from);
      dateCond = ` AND created_at::date >= $2`;
    } else if (date_to) {
      params.push(date_to);
      dateCond = ` AND created_at::date <= $2`;
    }
    const { rows } = await query(
      `SELECT id, transaction_type, quantity, amount_usd, amount_ves, created_at, staff_id
       FROM transactions WHERE client_id = $1${dateCond} ORDER BY created_at DESC LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// Top clients by purchase volume (staff only)
router.get('/top/:establishmentId', requireStaffSession, async (req, res, next) => {
  try {
    const { establishmentId } = req.params;
    if (Number(req.establishmentId) !== Number(establishmentId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { date_from, date_to } = req.query;
    const params = [establishmentId];
    let dateCond = '';
    if (date_from && date_to) {
      params.push(date_from, date_to);
      dateCond = ` AND t.created_at::date BETWEEN $2 AND $3`;
    }
    const { rows } = await query(
      `SELECT c.id, c.full_name, c.phone,
              COALESCE(SUM(t.quantity),0) AS total_beers,
              COALESCE(SUM(t.amount_usd),0) AS total_usd,
              COUNT(*) AS sales_count
       FROM transactions t JOIN clients c ON c.id = t.client_id
       WHERE t.establishment_id = $1 AND t.transaction_type <> 'CREDIT_PAYMENT'${dateCond}
       GROUP BY c.id, c.full_name, c.phone
       ORDER BY total_beers DESC LIMIT 5`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;
