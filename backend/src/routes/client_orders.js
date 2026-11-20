import { Router } from 'express';
import { pool, query } from '../db/pool.js';
import { emitToRoom } from '../lib/socket.js';
import { broadcastSse } from './events.js';
import { auditLog } from '../lib/audit.js';
import { requireStaffSession } from '../middleware/auth.js';
import { hashAccessToken } from '../lib/token.js';

const router = Router();

// Create a client withdrawal order (bloquea saldo, no lo descuenta todavía)
// Accepts either staff session OR client access_token (via x-client-token header or query)
router.post('/', async (req, res, next) => {
  const { establishment_id, client_id, quantity } = req.body || {};

  // Auth: staff session or client token (header only — never via URL, to avoid token leaks).
  const { getStaffSession } = await import('../lib/session.js');
  const session = await getStaffSession(req.headers['x-session-token']);
  const clientToken = req.headers['x-client-token'];
  const passkeyAuthorization = req.headers['x-client-passkey-auth'];

  if (!session && !clientToken) {
    return res.status(401).json({ error: 'Authentication required: staff session or client token' });
  }

  // If client token, verify it matches the client_id
  if (clientToken) {
    const { rows } = await query(
      `SELECT id FROM clients WHERE id = $1 AND access_token = $2 AND establishment_id = $3
       AND (token_expires_at IS NULL OR token_expires_at > NOW())`,
      [client_id, hashAccessToken(clientToken), establishment_id]
    );
    if (!rows[0]) {
      return res.status(403).json({ error: 'Client token does not match this client' });
    }
  }

  // If staff session, verify establishment match
  if (session && Number(session.establishment_id) !== Number(establishment_id)) {
    return res.status(403).json({ error: 'Staff session belongs to another establishment' });
  }
  if (!establishment_id || !client_id || !quantity) {
    return res.status(400).json({ error: 'establishment_id, client_id and quantity are required' });
  }
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive integer' });
  }

  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');

    // Verify client exists and has enough balance
    const { rows: clientRows } = await db.query(
      `SELECT c.id, c.establishment_id, c.full_name, COALESCE(c.current_balance, 0) AS current_balance
       FROM clients c
       WHERE c.id = $1 AND c.establishment_id = $2
       FOR UPDATE`,
      [client_id, establishment_id]
    );
    const client = clientRows[0];
    if (!client) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Client not found' });
    }
    if (client.current_balance < qty) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Saldo insuficiente para esta solicitud' });
    }

    const { rows: enrolledPasskeys } = await db.query(
      `SELECT 1 FROM client_passkeys WHERE client_id = $1 AND establishment_id = $2 LIMIT 1`,
      [client_id, establishment_id]
    );
    let passkeyAuthorized = false;
    if (clientToken && enrolledPasskeys.length) {
      if (!passkeyAuthorization) {
        await db.query('ROLLBACK');
        return res.status(401).json({ error: 'Passkey authentication required to request a withdrawal' });
      }
      const { rows: authorizations } = await db.query(
        `DELETE FROM client_passkey_authorizations
         WHERE token_hash = $1 AND client_id = $2 AND establishment_id = $3
           AND scope = 'withdrawal' AND quantity = $4 AND expires_at > NOW()
         RETURNING token_hash`,
        [hashAccessToken(passkeyAuthorization), client_id, establishment_id, qty]
      );
      if (!authorizations.length) {
        await db.query('ROLLBACK');
        return res.status(401).json({ error: 'Passkey authorization is invalid, expired or bound to another quantity' });
      }
      passkeyAuthorized = true;
    }

    // Block the balance (reserve it) - we subtract now but mark as pending
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes default

    const { rows } = await db.query(
      `INSERT INTO client_orders
       (establishment_id, client_id, quantity, status, expires_at, passkey_authorized)
       VALUES ($1, $2, $3, 'SOLICITADO', $4, $5)
       RETURNING *`,
      [establishment_id, client_id, qty, expiresAt, passkeyAuthorized]
    );
    const order = rows[0];

    await db.query('COMMIT');

    // Notify bartender in real time
    const payload = {
      order_id: order.id,
      client_id: client.id,
      client_name: client.full_name,
      establishment_id: client.establishment_id,
      quantity: qty,
      status: 'SOLICITADO',
      requested_at: order.requested_at,
      expires_at: order.expires_at,
      passkey_authorized: order.passkey_authorized
    };
    emitToRoom('client_order', payload, establishment_id);
    broadcastSse('client_order', payload, establishment_id);

    await auditLog({
      establishmentId: establishment_id,
      staffId: null,
      clientId: order.client_id,
      action: 'client_order_created',
      entityType: 'client_order',
      entityId: order.id,
      details: { quantity: order.quantity, status: order.status },
      ipAddress: req.ip || null,
    });

    res.status(201).json(order);
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    next(e);
  } finally {
    if (db) db.release();
  }
});

// List client orders for an establishment (staff only)
router.get('/', requireStaffSession, async (req, res, next) => {
  try {
    const { establishment_id, status, limit = 50 } = req.query;
    if (!establishment_id) return res.status(400).json({ error: 'establishment_id required' });
    if (Number(req.establishmentId) !== Number(establishment_id)) {
      return res.status(403).json({ error: 'Forbidden: session does not belong to this establishment' });
    }

    const params = [establishment_id];
    let sql = `SELECT co.*, c.full_name AS client_name, c.document_id, c.phone,
                      s.name AS staff_name
               FROM client_orders co
               JOIN clients c ON c.id = co.client_id
               LEFT JOIN staff s ON s.id = co.staff_id
               WHERE co.establishment_id = $1`;
    if (status) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        params.push(statuses[0]);
        sql += ` AND co.status = $${params.length}`;
      } else {
        const placeholders = statuses.map((_, i) => `$${params.length + i + 1}`).join(',');
        params.push(...statuses);
        sql += ` AND co.status IN (${placeholders})`;
      }
    }
    sql += ` ORDER BY
             CASE co.status
               WHEN 'SOLICITADO' THEN 1
               WHEN 'EN_PREPARACION' THEN 2
               WHEN 'ENTREGADO' THEN 3
               WHEN 'CANCELADO' THEN 4
               WHEN 'EXPIRADO' THEN 5
             END,
             co.requested_at DESC
             LIMIT $${params.length + 1}`;
    params.push(parseInt(limit, 10));

    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// Accept order: cambia a EN_PREPARACION sin descontar saldo (el descuento ocurre al entregar con código válido)
router.patch('/:id/accept', requireStaffSession, async (req, res, next) => {
  const { id } = req.params;
  const session = req.session;

  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');

    const { rows: orderRows } = await db.query(
      `SELECT co.*, c.establishment_id
       FROM client_orders co
       JOIN clients c ON c.id = co.client_id
       WHERE co.id = $1 AND co.establishment_id = $2
       FOR UPDATE`,
      [id, session.establishment_id]
    );
    const order = orderRows[0];
    if (!order) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'SOLICITADO') {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Order is not in SOLICITADO state' });
    }

    // No se descuenta saldo aquí. El descuento ocurre al entregar con código válido.
    // Solo asignar el bartender y cambiar el estado a EN_PREPARACION
    await db.query(
      `UPDATE client_orders SET status = 'EN_PREPARACION', staff_id = $1, prepared_at = NOW() WHERE id = $2`,
      [session.staff?.id || null, id]
    );

    await db.query('COMMIT');

    await auditLog({
      establishmentId: order.establishment_id,
      staffId: session.staff?.id || null,
      clientId: order.client_id,
      action: 'client_order_accepted',
      entityType: 'client_order',
      entityId: order.id,
      details: { quantity: order.quantity },
      ipAddress: req.ip || null,
    });

    const payload = {
      order_id: order.id,
      client_id: order.client_id,
      establishment_id: order.establishment_id,
      quantity: order.quantity,
      status: 'EN_PREPARACION',
      staff_id: session.staff?.id || null,
      passkey_authorized: order.passkey_authorized
    };
    emitToRoom('client_order_accepted', payload, order.establishment_id);
    broadcastSse('client_order_accepted', payload, order.establishment_id);

    res.json({ ok: true, status: 'EN_PREPARACION' });
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    next(e);
  } finally {
    if (db) db.release();
  }
});

// Deliver order: marca como ENTREGADO (requiere código de verificación del cliente, a menos que haya autorizado con passkey)
router.patch('/:id/deliver', requireStaffSession, async (req, res, next) => {
  const { id } = req.params;
  const session = req.session;

  const { verification_code } = req.body || {};

  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');

    // Verify order exists and is in EN_PREPARACION state
const { rows: orderRows } = await db.query(
      `SELECT co.*, c.establishment_id, c.verification_code, c.verification_code_expires_at, co.passkey_authorized
       FROM client_orders co
       JOIN clients c ON c.id = co.client_id
       WHERE co.id = $1 AND co.establishment_id = $2
       FOR UPDATE`,
      [id, session.establishment_id]
    );
    const order = orderRows[0];
    if (!order) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'EN_PREPARACION') {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Order is not in EN_PREPARACION state' });
    }

    // If passkey was used to authorize the order, skip verification code check
    if (!order.passkey_authorized) {
      if (!verification_code || !/^\d{4}$/.test(String(verification_code))) {
        await db.query('ROLLBACK');
        return res.status(400).json({ error: 'Código de verificación de 4 dígitos requerido para entregar' });
      }

      // Verify client's verification code
      const now = new Date();
      const codeValid = order.verification_code &&
        order.verification_code === String(verification_code) &&
        order.verification_code_expires_at &&
        new Date(order.verification_code_expires_at) > now;

      if (!codeValid) {
        await db.query('ROLLBACK');
        return res.status(401).json({ error: 'Código de verificación inválido o expirado. Pida al cliente que muestre su código actual.' });
      }
    }

    // Verify client has sufficient balance at delivery time
    const { rows: clientRows } = await db.query(
      `SELECT current_balance FROM clients WHERE id = $1 FOR UPDATE`,
      [order.client_id]
    );
    const currentBalance = Number(clientRows[0].current_balance || 0);
    if (currentBalance < order.quantity) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Saldo insuficiente al entregar la orden' });
    }

    // Deduct balance ONLY at delivery time (after code validation)
    const newBalance = currentBalance - order.quantity;
    await db.query(
      `UPDATE clients SET current_balance = $1 WHERE id = $2`,
      [newBalance, order.client_id]
    );

    // Register redemption transaction at delivery time
    await db.query(
      `INSERT INTO transactions
        (establishment_id, client_id, staff_id, transaction_type, quantity,
         amount_usd, amount_ves, payment_method, request_id)
        VALUES ($1, $2, $3, 'REDEMPTION', $4, $5, $6, 'balance', $7)`,
      [order.establishment_id, order.client_id, session.staff?.id || null, order.quantity, 0, 0, null]
    );

    // Update order status to delivered
    await db.query(
      `UPDATE client_orders SET status = 'ENTREGADO', delivered_at = NOW() WHERE id = $1`,
      [id]
    );

    await db.query('COMMIT');

    await auditLog({
      establishmentId: order.establishment_id,
      staffId: session.staff?.id || null,
      clientId: order.client_id,
      action: 'client_order_delivered_verified',
      entityType: 'client_order',
      entityId: order.id,
      details: { quantity: order.quantity, verification_code: String(verification_code), new_balance: newBalance },
      ipAddress: req.ip || null,
    });

    const payload = {
      order_id: order.id,
      client_id: order.client_id,
      establishment_id: order.establishment_id,
      quantity: order.quantity,
      status: 'ENTREGADO',
      new_balance: newBalance,
      passkey_authorized: order.passkey_authorized
    };
    emitToRoom('client_order_delivered', payload, order.establishment_id);
    broadcastSse('client_order_delivered', payload, order.establishment_id);

    res.json({ ok: true, status: 'ENTREGADO', new_balance: newBalance });
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    next(e);
  } finally {
    if (db) db.release();
  }
});

// Cancel order: libera el saldo bloqueado
router.patch('/:id/cancel', requireStaffSession, async (req, res, next) => {
  const { id } = req.params;
  const session = req.session;

  let db;
  try {
    db = await pool.connect();
    await db.query('BEGIN');

    const { rows: orderRows } = await db.query(
      `SELECT co.*, c.establishment_id
       FROM client_orders co
       JOIN clients c ON c.id = co.client_id
       WHERE co.id = $1 AND co.establishment_id = $2
       FOR UPDATE`,
      [id, session.establishment_id]
    );
    const order = orderRows[0];
    if (!order) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'SOLICITADO') {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Only SOLICITADO orders can be cancelled' });
    }

    await db.query(
      `UPDATE client_orders SET status = 'CANCELADO' WHERE id = $1`,
      [id]
    );

    await db.query('COMMIT');

    await auditLog({
      establishmentId: order.establishment_id,
      staffId: session.staff?.id || null,
      clientId: order.client_id,
      action: 'client_order_cancelled',
      entityType: 'client_order',
      entityId: order.id,
      details: { quantity: order.quantity },
      ipAddress: req.ip || null,
    });

    const payload = {
      order_id: order.id,
      client_id: order.client_id,
      establishment_id: order.establishment_id,
      quantity: order.quantity,
      status: 'CANCELADO',
      passkey_authorized: order.passkey_authorized
    };
    emitToRoom('client_order_cancelled', payload, order.establishment_id);
    broadcastSse('client_order_cancelled', payload, order.establishment_id);

    res.json({ ok: true, status: 'CANCELADO' });
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    next(e);
  } finally {
    if (db) db.release();
  }
});

export default router;
