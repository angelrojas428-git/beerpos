import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireStaffSession } from '../middleware/auth.js';
import { auditLog } from '../lib/audit.js';

const router = Router();

function stockPayload(row) {
  const stock = row.beer_stock === null || row.beer_stock === undefined ? null : Number(row.beer_stock);
  const min = Number(row.beer_stock_min || 0);
  return {
    beer_stock: stock,
    beer_stock_min: min,
    low_stock: stock !== null && stock <= min,
    stock_updated_at: row.stock_updated_at || null,
  };
}

function assertEst(req, res) {
  const estId = Number(req.params.establishmentId);
  if (!Number.isFinite(estId) || estId <= 0) {
    res.status(400).json({ error: 'establishmentId inválido' });
    return null;
  }
  if (Number(req.establishmentId) !== estId) {
    res.status(403).json({ error: 'Forbidden: la sesión no pertenece a este establecimiento' });
    return null;
  }
  return estId;
}

// Stock actual (y umbral de alerta).
router.get('/:establishmentId', requireStaffSession, async (req, res, next) => {
  try {
    const estId = assertEst(req, res);
    if (!estId) return;
    const { rows } = await query(
      `SELECT beer_stock, beer_stock_min, stock_updated_at FROM establishments WHERE id = $1`,
      [estId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Establecimiento no encontrado' });
    res.json(stockPayload(rows[0]));
  } catch (e) { next(e); }
});

// Fijar stock y/o umbral. `beer_stock: null` desactiva el control de stock.
router.put('/:establishmentId', requireStaffSession, async (req, res, next) => {
  try {
    const estId = assertEst(req, res);
    if (!estId) return;
    const { beer_stock, beer_stock_min } = req.body || {};
    const updates = [];
    const params = [];
    let i = 1;

    if (beer_stock !== undefined) {
      if (beer_stock !== null) {
        const n = Number(beer_stock);
        if (!Number.isInteger(n) || n < 0) {
          return res.status(400).json({ error: 'beer_stock debe ser un entero ≥ 0 o null' });
        }
      }
      updates.push(`beer_stock = $${i++}`);
      params.push(beer_stock === null ? null : Number(beer_stock));
    }

    if (beer_stock_min !== undefined) {
      const m = Number(beer_stock_min);
      if (!Number.isInteger(m) || m < 0) {
        return res.status(400).json({ error: 'beer_stock_min debe ser un entero ≥ 0' });
      }
      updates.push(`beer_stock_min = $${i++}`);
      params.push(m);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar' });
    }

    updates.push('stock_updated_at = NOW()');
    params.push(estId);
    const { rows } = await query(
      `UPDATE establishments SET ${updates.join(', ')} WHERE id = $${i} RETURNING beer_stock, beer_stock_min, stock_updated_at`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Establecimiento no encontrado' });

    await auditLog({
      establishmentId: estId,
      staffId: req.session.staff?.id || null,
      action: 'stock_set',
      entityType: 'establishment',
      entityId: estId,
      details: { beer_stock: rows[0].beer_stock, beer_stock_min: rows[0].beer_stock_min },
      ipAddress: req.ip || null,
    });

    res.json(stockPayload(rows[0]));
  } catch (e) { next(e); }
});

// Ajuste relativo (restock positivo / corrección negativa). Si el stock no está
// controlado (NULL) empieza desde 0.
router.post('/:establishmentId/adjust', requireStaffSession, async (req, res, next) => {
  try {
    const estId = assertEst(req, res);
    if (!estId) return;
    const { delta } = req.body || {};
    const d = Number(delta);
    if (!Number.isInteger(d) || d === 0) {
      return res.status(400).json({ error: 'delta debe ser un entero distinto de cero' });
    }

    const { rows } = await query(
      `UPDATE establishments
          SET beer_stock = GREATEST(0, COALESCE(beer_stock, 0) + $1),
              stock_updated_at = NOW()
        WHERE id = $2
        RETURNING beer_stock, beer_stock_min, stock_updated_at`,
      [d, estId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Establecimiento no encontrado' });

    await auditLog({
      establishmentId: estId,
      staffId: req.session.staff?.id || null,
      action: 'stock_adjust',
      entityType: 'establishment',
      entityId: estId,
      details: { delta: d, beer_stock: rows[0].beer_stock },
      ipAddress: req.ip || null,
    });

    res.json(stockPayload(rows[0]));
  } catch (e) { next(e); }
});

export default router;