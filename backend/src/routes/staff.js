import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireStaffSession, requireOwnerRole } from '../middleware/auth.js';
import { hashPin, validatePin } from '../lib/pin.js';
import { auditLog } from '../lib/audit.js';

const router = Router();

const STAFF_FIELDS = `id, name, role, active, totp_enabled, created_at`;

function estFromSession(req, res) {
  const estId = Number(req.establishmentId);
  if (!Number.isFinite(estId) || estId <= 0) {
    res.status(403).json({ error: 'Forbidden: sin establecimiento en la sesión' });
    return null;
  }
  return estId;
}

// List staff (active + inactive) for the session's establishment.
router.get('/', requireStaffSession, async (req, res, next) => {
  try {
    const estId = estFromSession(req, res);
    if (!estId) return;
    const { rows } = await query(
      `SELECT ${STAFF_FIELDS} FROM staff WHERE establishment_id = $1 ORDER BY active DESC, role, name`,
      [estId]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// Create a staff member (owner only).
router.post('/', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const estId = estFromSession(req, res);
    if (!estId) return;

    const name = String(req.body?.name || '').trim();
    const pin = String(req.body?.pin || '');
    const role = req.body?.role === 'owner' ? 'owner' : 'bartender';

    if (!name || name.length > 150) {
      return res.status(400).json({ error: 'El nombre es obligatorio (máx. 150 caracteres).' });
    }
    const policy = validatePin(pin);
    if (!policy.ok) return res.status(400).json({ error: policy.error });

    const dup = await query(
      `SELECT 1 FROM staff WHERE establishment_id = $1 AND lower(name) = lower($2)`,
      [estId, name]
    );
    if (dup.rows.length) return res.status(409).json({ error: 'Ya existe un usuario con ese nombre.' });

    const hashed = await hashPin(pin);
    const { rows } = await query(
      `INSERT INTO staff (establishment_id, name, pin, role) VALUES ($1, $2, $3, $4) RETURNING ${STAFF_FIELDS}`,
      [estId, name, hashed, role]
    );

    await auditLog({
      establishmentId: estId,
      staffId: req.session.staff?.id || null,
      action: 'staff_create',
      entityType: 'staff',
      entityId: rows[0].id,
      details: { name, role },
      ipAddress: req.ip || null,
    });

    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// Update a staff member (owner only). Guards prevent lockout.
router.patch('/:id', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const estId = estFromSession(req, res);
    if (!estId) return;
    const id = Number(req.params.id);

    const { rows: existingRows } = await query(
      `SELECT * FROM staff WHERE id = $1 AND establishment_id = $2`,
      [id, estId]
    );
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });

    const selfId = Number(req.session.staff?.id);
    const isSelf = selfId === id;

    const updates = [];
    const params = [];
    let i = 1;

    let nextRole = existing.role;
    let nextActive = existing.active;

    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name || name.length > 150) {
        return res.status(400).json({ error: 'El nombre es obligatorio (máx. 150 caracteres).' });
      }
      const dup = await query(
        `SELECT 1 FROM staff WHERE establishment_id = $1 AND lower(name) = lower($2) AND id <> $3`,
        [estId, name, id]
      );
      if (dup.rows.length) return res.status(409).json({ error: 'Ya existe un usuario con ese nombre.' });
      updates.push(`name = $${i++}`); params.push(name);
    }

    if (req.body.role !== undefined) {
      const role = req.body.role === 'owner' ? 'owner' : 'bartender';
      nextRole = role;
      updates.push(`role = $${i++}`); params.push(role);
    }

    if (req.body.active !== undefined) {
      const active = req.body.active === true || req.body.active === 'true';
      nextActive = active;
      updates.push(`active = $${i++}`); params.push(active);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

    // Lockout guards.
    if (isSelf && nextActive === false) {
      return res.status(400).json({ error: 'No puedes desactivar tu propio usuario.' });
    }
    if (isSelf && nextRole !== 'owner') {
      return res.status(400).json({ error: 'No puedes quitarte el rol de dueño.' });
    }
    // Never remove the last active owner.
    if (existing.role === 'owner' && (nextActive === false || nextRole !== 'owner')) {
      const { rows: owners } = await query(
        `SELECT COUNT(*)::int AS n FROM staff WHERE establishment_id = $1 AND role = 'owner' AND active = true AND id <> $2`,
        [estId, id]
      );
      if (Number(owners[0]?.n || 0) === 0) {
        return res.status(400).json({ error: 'No puedes quitar o desactivar al último dueño activo.' });
      }
    }

    params.push(id, estId);
    const { rows } = await query(
      `UPDATE staff SET ${updates.join(', ')} WHERE id = $${i} AND establishment_id = $${i + 1} RETURNING ${STAFF_FIELDS}`,
      params
    );

    await auditLog({
      establishmentId: estId,
      staffId: selfId || null,
      action: 'staff_update',
      entityType: 'staff',
      entityId: id,
      details: { name: req.body.name, role: req.body.role, active: req.body.active },
      ipAddress: req.ip || null,
    });

    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Soft-delete (deactivate) a staff member (owner only).
router.delete('/:id', requireStaffSession, requireOwnerRole, async (req, res, next) => {
  try {
    const estId = estFromSession(req, res);
    if (!estId) return;
    const id = Number(req.params.id);

    const { rows: existingRows } = await query(
      `SELECT * FROM staff WHERE id = $1 AND establishment_id = $2`,
      [id, estId]
    );
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'Usuario no encontrado' });

    const selfId = Number(req.session.staff?.id);
    if (selfId === id) {
      return res.status(400).json({ error: 'No puedes desactivar tu propio usuario.' });
    }
    if (existing.role === 'owner') {
      const { rows: owners } = await query(
        `SELECT COUNT(*)::int AS n FROM staff WHERE establishment_id = $1 AND role = 'owner' AND active = true AND id <> $2`,
        [estId, id]
      );
      if (Number(owners[0]?.n || 0) === 0) {
        return res.status(400).json({ error: 'No puedes desactivar al último dueño activo.' });
      }
    }

    const { rows } = await query(
      `UPDATE staff SET active = false WHERE id = $1 AND establishment_id = $2 RETURNING ${STAFF_FIELDS}`,
      [id, estId]
    );

    await auditLog({
      establishmentId: estId,
      staffId: selfId || null,
      action: 'staff_deactivate',
      entityType: 'staff',
      entityId: id,
      details: { name: existing.name },
      ipAddress: req.ip || null,
    });

    res.json(rows[0]);
  } catch (e) { next(e); }
});

export default router;