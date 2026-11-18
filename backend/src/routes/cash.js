import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireStaffSession } from '../middleware/auth.js';
import { auditLog } from '../lib/audit.js';

const router = Router();

function estFromSession(req, res) {
  const estId = Number(req.establishmentId);
  if (!Number.isFinite(estId) || estId <= 0) {
    res.status(403).json({ error: 'Forbidden: sin establecimiento en la sesión' });
    return null;
  }
  return estId;
}

// Totales del turno desde su apertura. `cash_in_usd` = todo lo cobrado en efectivo
// (ventas cash + abonos de crédito en efectivo). `non_cash_in_usd` = otros medios.
async function getTotals(estId, since) {
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount_usd ELSE 0 END),0) AS cash_in_usd,
       COALESCE(SUM(CASE WHEN payment_method <> 'cash' THEN amount_usd ELSE 0 END),0) AS non_cash_in_usd,
       COALESCE(SUM(CASE WHEN transaction_type <> 'CREDIT_PAYMENT' THEN amount_usd ELSE 0 END),0) AS total_sales_usd,
       COUNT(*) FILTER (WHERE transaction_type <> 'CREDIT_PAYMENT')::int AS sales_count
     FROM transactions
     WHERE establishment_id = $1 AND created_at >= $2`,
    [estId, since]
  );
  const r = rows[0] || {};
  return {
    cash_in_usd: Number(r.cash_in_usd || 0),
    non_cash_in_usd: Number(r.non_cash_in_usd || 0),
    total_sales_usd: Number(r.total_sales_usd || 0),
    sales_count: Number(r.sales_count || 0),
  };
}

function shiftView(shift) {
  return {
    id: shift.id,
    opened_at: shift.opened_at,
    opened_by: shift.opened_by,
    opening_float_usd: Number(shift.opening_float_usd),
  };
}

// Turno abierto actual + totales en vivo.
router.get('/current', requireStaffSession, async (req, res, next) => {
  try {
    const estId = estFromSession(req, res);
    if (!estId) return;
    const { rows } = await query(
      `SELECT * FROM cash_shifts WHERE establishment_id = $1 AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1`,
      [estId]
    );
    if (!rows[0]) return res.json({ open: false });
    const totals = await getTotals(estId, rows[0].opened_at);
    const expected = Number((Number(rows[0].opening_float_usd) + totals.cash_in_usd).toFixed(2));
    res.json({ open: true, shift: shiftView(rows[0]), totals, expected_usd: expected });
  } catch (e) { next(e); }
});

// Abrir caja.
router.post('/open', requireStaffSession, async (req, res, next) => {
  try {
    const estId = estFromSession(req, res);
    if (!estId) return;
    const opening = Number(req.body?.opening_float_usd ?? 0);
    if (!Number.isFinite(opening) || opening < 0) {
      return res.status(400).json({ error: 'opening_float_usd debe ser un número ≥ 0' });
    }

    let result;
    try {
      result = await query(
        `INSERT INTO cash_shifts (establishment_id, opened_by, opening_float_usd, status)
         VALUES ($1, $2, $3, 'OPEN')
         RETURNING *`,
        [estId, req.session.staff?.id || null, opening]
      );
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Ya hay una caja abierta' });
      throw e;
    }

    await auditLog({
      establishmentId: estId,
      staffId: req.session.staff?.id || null,
      action: 'cash_open',
      entityType: 'cash_shift',
      entityId: result.rows[0].id,
      details: { opening_float_usd: opening },
      ipAddress: req.ip || null,
    });

    res.status(201).json({
      open: true,
      shift: shiftView(result.rows[0]),
      totals: { cash_in_usd: 0, non_cash_in_usd: 0, total_sales_usd: 0, sales_count: 0 },
      expected_usd: Number(opening.toFixed(2)),
    });
  } catch (e) { next(e); }
});

// Cerrar caja (calcula esperado y diferencia).
router.post('/close', requireStaffSession, async (req, res, next) => {
  try {
    const estId = estFromSession(req, res);
    if (!estId) return;
    const counted = Number(req.body?.counted_usd);
    if (!Number.isFinite(counted) || counted < 0) {
      return res.status(400).json({ error: 'counted_usd debe ser un número ≥ 0' });
    }

    const { rows: openRows } = await query(
      `SELECT * FROM cash_shifts WHERE establishment_id = $1 AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1`,
      [estId]
    );
    if (!openRows[0]) return res.status(404).json({ error: 'No hay caja abierta' });
    const shift = openRows[0];

    const totals = await getTotals(estId, shift.opened_at);
    const expected = Number((Number(shift.opening_float_usd) + totals.cash_in_usd).toFixed(2));
    const difference = Number((counted - expected).toFixed(2));

    const { rows } = await query(
      `UPDATE cash_shifts
          SET status = 'CLOSED', closed_at = NOW(), closed_by = $2,
              cash_sales_usd = $3, other_sales_usd = $4, total_sales_usd = $5,
              expected_usd = $6, counted_usd = $7, difference_usd = $8, notes = $9, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        shift.id,
        req.session.staff?.id || null,
        totals.cash_in_usd,
        totals.non_cash_in_usd,
        totals.total_sales_usd,
        expected,
        counted,
        difference,
        req.body?.notes || null,
      ]
    );

    await auditLog({
      establishmentId: estId,
      staffId: req.session.staff?.id || null,
      action: 'cash_close',
      entityType: 'cash_shift',
      entityId: shift.id,
      details: { expected_usd: expected, counted_usd: counted, difference_usd: difference },
      ipAddress: req.ip || null,
    });

    res.json({ open: false, shift: rows[0] });
  } catch (e) { next(e); }
});

// Historial de turnos cerrados.
router.get('/history', requireStaffSession, async (req, res, next) => {
  try {
    const estId = estFromSession(req, res);
    if (!estId) return;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const { rows } = await query(
      `SELECT * FROM cash_shifts WHERE establishment_id = $1 AND status = 'CLOSED' ORDER BY closed_at DESC LIMIT $2`,
      [estId, limit]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;