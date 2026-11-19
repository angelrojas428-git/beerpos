import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireStaffSession } from '../middleware/auth.js';

const router = Router();

router.get('/:establishmentId', requireStaffSession, async (req, res, next) => {
  try {
    const { establishmentId } = req.params;
    if (Number(req.establishmentId) !== Number(establishmentId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { action, staff_id, limit = 100 } = req.query;
    const params = [establishmentId];
    let where = 'WHERE establishment_id = $1';
    if (action) { params.push(action); where += ` AND action = $${params.length}`; }
    if (staff_id) { params.push(staff_id); where += ` AND staff_id = $${params.length}`; }
    params.push(Math.min(Number(limit) || 100, 500));
    const { rows } = await query(
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;
