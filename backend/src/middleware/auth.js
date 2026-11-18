import { getStaffSession } from '../lib/session.js';

/**
 * Middleware: requires a valid staff session.
 * Attaches session and staff to req.
 * Returns 401 if no valid session token is provided.
 */
export async function requireStaffSession(req, res, next) {
  try {
    const token = req.headers['x-session-token'];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required: missing session token' });
    }
    const session = await getStaffSession(token);
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized or session expired' });
    }
    req.session = session;
    req.staff = session.staff;
    req.establishmentId = session.establishment_id;
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Middleware: requires a valid staff session AND verifies the establishment ID
 * in the request body/query/params matches the session's establishment.
 * Must be used AFTER requireStaffSession.
 */
export function requireStaffSessionForEst(req, res, next) {
  const estId = Number(
    req.params.id ||
    req.params.establishmentId ||
    req.body?.establishment_id ||
    req.query?.establishment_id
  );
  if (req.establishmentId == null) {
    return res.status(403).json({ error: 'Forbidden: no establishment in session' });
  }
  if (Number.isFinite(estId) && estId > 0 && Number(req.establishmentId) !== estId) {
    return res.status(403).json({ error: 'Forbidden: session does not belong to this establishment' });
  }
  next();
}

/**
 * Middleware: requires a staff session with 'platform_admin' role.
 * Platform admins operate across establishments (their session has no establishment).
 * Must be used AFTER requireStaffSession.
 */
export function requirePlatformAdmin(req, res, next) {
  if (req.staff?.role !== 'platform_admin') {
    return res.status(403).json({ error: 'Forbidden: platform admin role required' });
  }
  next();
}

/**
 * Middleware: requires a staff session with 'owner' role.
 * Must be used AFTER requireStaffSession.
 */
export function requireOwnerRole(req, res, next) {
  if (req.staff?.role !== 'owner') {
    return res.status(403).json({ error: 'Forbidden: owner role required' });
  }
  next();
}