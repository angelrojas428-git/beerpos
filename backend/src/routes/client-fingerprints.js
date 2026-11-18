import { Router } from 'express';
import { query } from '../db/pool.js';
import { encryptFingerprintTemplate, decryptFingerprintTemplate } from '../lib/fingerprint.js';
import { requireStaffSession } from '../middleware/auth.js';
import { clientLimiter } from '../middleware/rateLimit.js';
import { emitToRoom } from '../lib/socket.js';
import { broadcastSse } from './events.js';
import { auditLog } from '../lib/audit.js';

const router = Router();

// Register a fingerprint template for a client (staff only)
router.post('/register', requireStaffSession, async (req, res, next) => {
  try {
    const session = req.session;
    const { client_id, template, finger_position = 'right_thumb' } = req.body || {};
    if (!client_id || !template) {
      return res.status(400).json({ error: 'client_id and template are required' });
    }
    if (typeof template !== 'string' || template.length > 4096) {
      return res.status(400).json({ error: 'template must be a string up to 4096 chars' });
    }

    // Verify client exists and belongs to same establishment
    const { rows: clientRows } = await query(
      `SELECT id, establishment_id FROM clients WHERE id = $1`,
      [client_id]
    );
    if (!clientRows[0]) return res.status(404).json({ error: 'Client not found' });
    if (Number(clientRows[0].establishment_id) !== Number(session.establishment_id)) {
      return res.status(403).json({ error: 'Client belongs to another establishment' });
    }

    const encrypted = encryptFingerprintTemplate(template);

    await query(
      `INSERT INTO client_fingerprints (client_id, establishment_id, template_encrypted, finger_position)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id, finger_position)
       DO UPDATE SET template_encrypted = $3, updated_at = NOW()`,
      [client_id, session.establishment_id, encrypted, finger_position]
    );

    await auditLog({
      establishmentId: session.establishment_id,
      staffId: session.staff?.id || null,
      clientId: client_id,
      action: 'fingerprint_registered',
      entityType: 'client_fingerprint',
      details: { finger_position },
      ipAddress: req.ip || null,
    });

    res.json({ ok: true, message: 'Fingerprint registered successfully' });
  } catch (e) { next(e); }
});

// List fingerprints for a client (staff only)
router.get('/client/:clientId', requireStaffSession, async (req, res, next) => {
  try {
    const session = req.session;
    const { clientId } = req.params;
    const { rows } = await query(
      `SELECT id, finger_position, registered_at, updated_at
       FROM client_fingerprints
       WHERE client_id = $1 AND establishment_id = $2
       ORDER BY registered_at DESC`,
      [clientId, session.establishment_id]
    );
    res.json({ fingerprints: rows });
  } catch (e) { next(e); }
});

// Delete a fingerprint (staff only)
router.delete('/:fingerprintId', requireStaffSession, async (req, res, next) => {
  try {
    const session = req.session;
    const { fingerprintId } = req.params;
    const { rows } = await query(
      `SELECT client_id FROM client_fingerprints WHERE id = $1 AND establishment_id = $2`,
      [fingerprintId, session.establishment_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Fingerprint not found' });

    await query(`DELETE FROM client_fingerprints WHERE id = $1`, [fingerprintId]);

    await auditLog({
      establishmentId: session.establishment_id,
      staffId: session.staff?.id || null,
      clientId: rows[0].client_id,
      action: 'fingerprint_deleted',
      entityType: 'client_fingerprint',
      details: { fingerprintId },
      ipAddress: req.ip || null,
    });

    res.json({ ok: true, message: 'Fingerprint deleted' });
  } catch (e) { next(e); }
});

// Verify a fingerprint against all registered templates in the establishment
// Staff only + rate limited. Does NOT expose client access_token.
router.post('/verify', requireStaffSession, clientLimiter, async (req, res, next) => {
  try {
    const session = req.session;
    const { template } = req.body || {};
    if (!template || typeof template !== 'string') {
      return res.status(400).json({ error: 'template is required' });
    }

    const establishmentId = session.establishment_id;

    // Fetch all registered fingerprints for this establishment
    const { rows } = await query(
      `SELECT cf.id, cf.client_id, cf.template_encrypted, c.full_name, c.document_id, c.phone,
              c.current_balance
       FROM client_fingerprints cf
       JOIN clients c ON c.id = cf.client_id
       WHERE cf.establishment_id = $1`,
      [establishmentId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No registered fingerprints for this establishment' });
    }

    // Compare against each stored template
    for (const row of rows) {
      try {
        const storedTemplate = decryptFingerprintTemplate(row.template_encrypted);
        if (storedTemplate === template) {
          await auditLog({
            establishmentId: Number(establishmentId),
            staffId: session.staff?.id || null,
            clientId: row.client_id,
            action: 'fingerprint_verified',
            entityType: 'client_fingerprint',
            details: { finger_position: row.finger_position, match: true },
            ipAddress: req.ip || null,
          });

          return res.json({
            ok: true,
            matched: true,
            client: {
              id: row.client_id,
              full_name: row.full_name,
              document_id: row.document_id,
              phone: row.phone,
              current_balance: row.current_balance,
            },
            finger_position: row.finger_position,
          });
        }
      } catch (e) {
        // Skip rows that fail decryption
        continue;
      }
    }

    // No match found
    await auditLog({
      establishmentId: Number(establishmentId),
      staffId: session.staff?.id || null,
      action: 'fingerprint_verify_failed',
      entityType: 'client_fingerprint',
      details: { reason: 'no_match' },
      ipAddress: req.ip || null,
    });

    res.status(404).json({ ok: false, matched: false, error: 'Fingerprint not recognized' });
  } catch (e) { next(e); }
});

export default router;
