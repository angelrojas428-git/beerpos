import { Router } from 'express';
import { query } from '../db/pool.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { createSession, getStaffSession, deleteSession } from '../lib/session.js';
import { getIO } from '../lib/socket.js';
import { auditLog } from '../lib/audit.js';
import { verifyTOTPToken, generateTOTPSecret, getTOTPAuthUrl } from '../lib/totp.js';
import { hashPin, verifyPin, isLegacyPin, validatePin } from '../lib/pin.js';
import { requireStaffSession, requirePlatformAdmin } from '../middleware/auth.js';
import { isLocked, recordFailure, recordSuccess } from '../lib/lockout.js';
import crypto from 'crypto';

// Temporary 2FA challenges store (in-memory; use Redis/DB for production)
if (!global.__beerposTotpChallenges) global.__beerposTotpChallenges = {};

const router = Router();

// Simple PIN session: staff login returns a session token.
// A platform admin (super-admin) logs in WITHOUT an establishment_id (or with 0 / "platform");
// their staff row has establishment_id = NULL and role = 'platform_admin'.
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { name, pin } = req.body;
    const rawEst = req.body.establishment_id;
    // Platform admin login is explicit: establishment_id 0 / "0" / "platform".
    const isPlatformLogin = rawEst === 0 || rawEst === '0' || rawEst === 'platform';
    if (!name || !pin) return res.status(400).json({ error: 'name and pin required' });
    if (!isPlatformLogin && (rawEst === undefined || rawEst === null || rawEst === '')) {
      return res.status(400).json({ error: 'establishment_id, name, pin required' });
    }
    // Non-numeric / non-positive establishment_id would break the integer FK lookup → reject cleanly.
    if (!isPlatformLogin && (!Number.isInteger(Number(rawEst)) || Number(rawEst) <= 0)) {
      return res.status(400).json({ error: 'establishment_id must be a positive integer' });
    }

    // Lockout key: platform admins share a dedicated namespace.
    const lockKeyEst = isPlatformLogin ? '__platform__' : rawEst;

    // Account lockout: reject before any credential check if the account is temporarily locked.
    const lock = isLocked(lockKeyEst, name);
    if (lock.locked) {
      const retryAfterSec = Math.ceil((lock.retryAfterMs || 0) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'Demasiados intentos fallidos. Intente de nuevo más tarde.',
        retryAfterSeconds: retryAfterSec,
      });
    }

    const { rows } = isPlatformLogin
      ? await query(
          `SELECT * FROM staff WHERE establishment_id IS NULL AND role = 'platform_admin' AND name = $1 AND active = true`,
          [name]
        )
      : await query(
          `SELECT * FROM staff WHERE establishment_id = $1 AND name = $2 AND active = true`,
          [rawEst, name]
        );
    if (!rows[0]) {
      recordFailure(lockKeyEst, name);
      await auditLog({
        establishmentId: isPlatformLogin ? null : Number(rawEst),
        action: isPlatformLogin ? 'platform_admin_login_failed' : 'staff_login_failed',
        entityType: 'staff',
        details: { name, reason: 'invalid_credentials' },
        ipAddress: req.ip || null,
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const staff = rows[0];
    // Canonical establishment for the session (null for platform admins).
    const staffEst = staff.establishment_id === undefined ? (isPlatformLogin ? null : rawEst) : staff.establishment_id;
    const pinValid = await verifyPin(pin, staff.pin);

    // Auto-migrate legacy plaintext PIN to bcrypt hash on successful login
    if (pinValid && isLegacyPin(staff.pin)) {
      const newHash = await hashPin(pin);
      await query('UPDATE staff SET pin = $1 WHERE id = $2', [newHash, staff.id]);
      staff.pin = newHash;
    }

    if (!pinValid) {
      recordFailure(lockKeyEst, name);
      await auditLog({
        establishmentId: isPlatformLogin ? null : Number(rawEst),
        action: isPlatformLogin ? 'platform_admin_login_failed' : 'staff_login_failed',
        entityType: 'staff',
        details: { name, reason: 'invalid_pin' },
        ipAddress: req.ip || null,
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // Correct PIN: clear any accumulated failures for this account.
    recordSuccess(lockKeyEst, name);

    // If 2FA is enabled, issue a temporary challenge instead of full session
    if (staff.totp_enabled && staff.totp_secret) {
      const challengeId = crypto.randomBytes(16).toString('hex');
      global.__beerposTotpChallenges[challengeId] = {
        staffId: staff.id,
        establishmentId: staffEst,
        createdAt: Date.now(),
      };
      // Expire challenges after 5 minutes
      setTimeout(() => {
        delete global.__beerposTotpChallenges[challengeId];
      }, 5 * 60 * 1000);

      return res.json({
        ok: true,
        requiresTotp: true,
        challengeId,
        staff: { id: staff.id, name: staff.name, role: staff.role, establishment_id: staffEst },
      });
    }

    const session = await createSession(staff, staffEst);
    await auditLog({
      establishmentId: staffEst === null ? null : Number(staffEst),
      staffId: staff.id,
      action: isPlatformLogin ? 'platform_admin_login' : 'staff_login',
      entityType: 'staff',
      entityId: staff.id,
      details: { name: staff.name, role: staff.role },
      ipAddress: req.ip || null,
    });
    res.json({ ok: true, sessionToken: session.sessionToken, staff: { id: staff.id, name: staff.name, role: staff.role, establishment_id: staffEst } });
  } catch (e) { next(e); }
});

// Verify TOTP code after PIN validation (2FA second step)
router.post('/login/verify-totp', authLimiter, async (req, res, next) => {
  try {
    const { challengeId, token } = req.body;
    if (!challengeId || !token) return res.status(400).json({ error: 'challengeId and token required' });

    const challenge = global.__beerposTotpChallenges[challengeId];
    if (!challenge) {
      return res.status(401).json({ error: 'Challenge inválido o expirado' });
    }

    // Challenge expires after 5 minutes
    if (Date.now() - challenge.createdAt > 5 * 60 * 1000) {
      delete global.__beerposTotpChallenges[challengeId];
      return res.status(401).json({ error: 'Challenge expirado' });
    }

    // Fetch staff to get TOTP secret
    const { rows } = await query(
      `SELECT * FROM staff WHERE id = $1 AND active = true`,
      [challenge.staffId]
    );
    if (!rows[0] || !rows[0].totp_secret) {
      delete global.__beerposTotpChallenges[challengeId];
      return res.status(401).json({ error: '2FA no configurado para este usuario' });
    }

    const valid = verifyTOTPToken(rows[0].totp_secret, token);
    const lockKeyEst = challenge.establishmentId === null || challenge.establishmentId === undefined ? '__platform__' : challenge.establishmentId;
    if (!valid) {
      recordFailure(lockKeyEst, rows[0].name);
      await auditLog({
        establishmentId: challenge.establishmentId,
        staffId: rows[0].id,
        action: 'staff_login_failed',
        entityType: 'staff',
        details: { name: rows[0].name, reason: 'invalid_totp' },
        ipAddress: req.ip || null,
      });
      return res.status(401).json({ error: 'Código 2FA inválido' });
    }

    // Correct TOTP: clear accumulated failures for this account.
    recordSuccess(lockKeyEst, rows[0].name);

    // Challenge consumed: delete it
    delete global.__beerposTotpChallenges[challengeId];

    const session = await createSession(rows[0], challenge.establishmentId);
    await auditLog({
      establishmentId: challenge.establishmentId,
      staffId: rows[0].id,
      action: 'staff_login',
      entityType: 'staff',
      entityId: rows[0].id,
      details: { name: rows[0].name, role: rows[0].role, mfa: true },
      ipAddress: req.ip || null,
    });
    res.json({ ok: true, sessionToken: session.sessionToken, staff: { id: rows[0].id, name: rows[0].name, role: rows[0].role, establishment_id: challenge.establishmentId } });
  } catch (e) { next(e); }
});

// Validate session (returns staff info)
router.get('/me', async (req, res, next) => {
  try {
    const session = await getStaffSession(req.headers['x-session-token']);
    if (!session) return res.status(401).json({ error: 'Unauthorized or session expired' });
    res.json({ ok: true, staff: session.staff, establishment_id: session.establishment_id });
  } catch (e) { next(e); }
});

// Logout
router.post('/logout', async (req, res, next) => {
  try {
    const token = req.headers['x-session-token'];
    if (token) {
      const session = await getStaffSession(token);
      if (session) {
        await auditLog({
          establishmentId: Number(session.establishment_id),
          staffId: session.staff?.id || null,
          action: 'staff_logout',
          entityType: 'staff',
          entityId: session.staff?.id || null,
          details: { name: session.staff?.name },
          ipAddress: req.ip || null,
        });
      }
      await deleteSession(token);
      for (const socket of getIO()?.sockets.sockets.values() || []) {
        if (socket.data.sessionToken === token) socket.disconnect(true);
      }
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Create establishment (platform admin only, authenticated).
// Owners cannot create new establishments; onboarding is done from the super-admin console.
router.post('/', requireStaffSession, requirePlatformAdmin, async (req, res, next) => {
  try {
    const { name, owner_name, phone, beer_price_usd, owner_pin } = req.body;
    if (!name || !owner_name) return res.status(400).json({ error: 'name and owner_name required' });
    if (owner_pin != null) {
      const policy = validatePin(owner_pin);
      if (!policy.ok) return res.status(400).json({ error: policy.error });
    }
    const db = await (await import('../db/pool.js')).pool.connect();
    try {
      await db.query('BEGIN');
      const { rows } = await db.query(
        `INSERT INTO establishments (name, owner_name, phone, beer_price_usd) VALUES ($1,$2,$3,$4) RETURNING *`,
        [name, owner_name, phone, beer_price_usd || 1.50]
      );
      const est = rows[0];
      if (owner_pin) {
        const hashedPin = await hashPin(owner_pin);
        await db.query(
          `INSERT INTO staff (establishment_id, name, pin, role) VALUES ($1,$2,$3,'owner')`,
          [est.id, owner_name, hashedPin]
        );
      }
      await db.query('COMMIT');
      res.status(201).json(est);
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  } catch (e) { next(e); }
});

// List establishments (for selection)
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, name, owner_name, phone, beer_price_usd, active FROM establishments ORDER BY id');
    res.json(rows);
  } catch (e) { next(e); }
});

// List staff for an establishment (used for report filters)
router.get('/staff', async (req, res, next) => {
  try {
    const { establishment_id } = req.query;
    if (!establishment_id) return res.status(400).json({ error: 'establishment_id required' });
    const { rows } = await query(
      `SELECT id, name, role, active FROM staff WHERE establishment_id = $1 AND active = true ORDER BY name`,
      [establishment_id]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// --- Change PIN ---
// Staff can change their own PIN (must provide current_pin).
// An owner can change any staff PIN in their establishment (staff_id) without current_pin.
router.post('/change-pin', requireStaffSession, async (req, res, next) => {
  try {
    const requester = req.staff;
    const { staff_id, current_pin, new_pin } = req.body || {};

    // Validate new PIN against policy.
    const policy = validatePin(new_pin);
    if (!policy.ok) return res.status(400).json({ error: policy.error });

    const targetId = staff_id != null ? Number(staff_id) : requester.id;

    // Non-owners may only change their own PIN and must prove the current PIN.
    if (requester.role !== 'owner') {
      if (targetId !== requester.id) {
        return res.status(403).json({ error: 'Forbidden: solo el owner puede cambiar el PIN de otros usuarios' });
      }
      if (!current_pin) {
        return res.status(400).json({ error: 'current_pin requerido' });
      }
      const currentValid = await verifyPin(current_pin, requester.pin);
      if (!currentValid) {
        return res.status(401).json({ error: 'PIN actual incorrecto' });
      }
    }

    // Target must belong to the requester's establishment and be active.
    const { rows } = await query(
      `SELECT id, name FROM staff WHERE id = $1 AND establishment_id = $2 AND active = true`,
      [targetId, req.establishmentId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Staff not found' });

    const hashed = await hashPin(new_pin);
    await query('UPDATE staff SET pin = $1 WHERE id = $2', [hashed, rows[0].id]);
    // Reset any lockout state for this account after a successful change.
    recordSuccess(req.establishmentId, rows[0].name);

    await auditLog({
      establishmentId: req.establishmentId,
      staffId: requester.id,
      action: 'staff_pin_changed',
      entityType: 'staff',
      entityId: rows[0].id,
      details: { target_name: rows[0].name },
      ipAddress: req.ip || null,
    });

    res.json({ ok: true, message: 'PIN actualizado correctamente' });
  } catch (e) { next(e); }
});

// --- 2FA (TOTP) configuration ---

// Helper to get staff from session token
async function getStaffFromSession(sessionToken) {
  const session = await getStaffSession(sessionToken);
  return session ? session.staff : null;
}

// Generate TOTP secret for authenticated staff
router.post('/2fa/setup', async (req, res, next) => {
  try {
    const token = req.headers['x-session-token'];
    const staff = await getStaffFromSession(token);
    if (!staff) return res.status(401).json({ error: 'Unauthorized or session expired' });

    const { rows } = await query(
      `SELECT id, name, establishment_id FROM staff WHERE id = $1 AND active = true`,
      [staff.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Staff not found' });

    const estResult = await query(
      `SELECT name FROM establishments WHERE id = $1`,
      [rows[0].establishment_id]
    );
    const estName = estResult.rows[0]?.name || 'Establecimiento';

    const secret = generateTOTPSecret();

    // Store secret pending verification (not enabled yet)
    await query(
      `UPDATE staff SET totp_secret = $1 WHERE id = $2`,
      [secret, staff.id]
    );

    const authUrl = getTOTPAuthUrl(secret, rows[0].name, estName);

    res.json({
      ok: true,
      secret,
      authUrl,
      staff: { id: staff.id, name: staff.name, role: staff.role },
    });
  } catch (e) { next(e); }
});

// Enable TOTP after verifying a valid code
router.post('/2fa/enable', async (req, res, next) => {
  try {
    const token = req.headers['x-session-token'];
    const staff = await getStaffFromSession(token);
    if (!staff) return res.status(401).json({ error: 'Unauthorized or session expired' });

    const { totpCode } = req.body;
    if (!totpCode) return res.status(400).json({ error: 'totpCode required' });

    const { rows } = await query(
      `SELECT totp_secret FROM staff WHERE id = $1 AND active = true`,
      [staff.id]
    );
    if (!rows[0] || !rows[0].totp_secret) {
      return res.status(400).json({ error: 'No hay secreto TOTP configurado. Ejecute /2fa/setup primero.' });
    }

    const valid = verifyTOTPToken(rows[0].totp_secret, totpCode);
    if (!valid) {
      await auditLog({
        establishmentId: staff.establishment_id,
        staffId: staff.id,
        action: 'staff_2fa_enable_failed',
        entityType: 'staff',
        entityId: staff.id,
        details: { name: staff.name, reason: 'invalid_code' },
        ipAddress: req.ip || null,
      });
      return res.status(401).json({ error: 'Código 2FA inválido' });
    }

    await query(`UPDATE staff SET totp_enabled = TRUE WHERE id = $1`, [staff.id]);

    await auditLog({
      establishmentId: staff.establishment_id,
      staffId: staff.id,
      action: 'staff_2fa_enabled',
      entityType: 'staff',
      entityId: staff.id,
      details: { name: staff.name },
      ipAddress: req.ip || null,
    });

    res.json({ ok: true, message: '2FA activado correctamente' });
  } catch (e) { next(e); }
});

// Disable TOTP
router.post('/2fa/disable', async (req, res, next) => {
  try {
    const token = req.headers['x-session-token'];
    const staff = await getStaffFromSession(token);
    if (!staff) return res.status(401).json({ error: 'Unauthorized or session expired' });

    await query(
      `UPDATE staff SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1`,
      [staff.id]
    );

    await auditLog({
      establishmentId: staff.establishment_id,
      staffId: staff.id,
      action: 'staff_2fa_disabled',
      entityType: 'staff',
      entityId: staff.id,
      details: { name: staff.name },
      ipAddress: req.ip || null,
    });

    res.json({ ok: true, message: '2FA desactivado correctamente' });
  } catch (e) { next(e); }
});

// Get 2FA status for authenticated staff
router.get('/2fa/status', async (req, res, next) => {
  try {
    const token = req.headers['x-session-token'];
    const staff = await getStaffFromSession(token);
    if (!staff) return res.status(401).json({ error: 'Unauthorized or session expired' });

    const { rows } = await query(
      `SELECT totp_enabled FROM staff WHERE id = $1 AND active = true`,
      [staff.id]
    );
    res.json({ ok: true, totpEnabled: Boolean(rows[0]?.totp_enabled) });
  } catch (e) { next(e); }
});

export default router;