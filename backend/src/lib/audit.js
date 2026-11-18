import { query } from '../db/pool.js';

/**
 * Registra un evento de auditoría en la tabla audit_log.
 * No lanza excepción si falla: la auditoría no debe interrumpir el flujo principal.
 */
export async function auditLog({
  establishmentId,
  staffId = null,
  clientId = null,
  action,
  entityType = null,
  entityId = null,
  details = {},
  ipAddress = null,
}) {
  try {
    await query(
      `INSERT INTO audit_log
        (establishment_id, staff_id, client_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [establishmentId, staffId, clientId, action, entityType, entityId, JSON.stringify(details), ipAddress]
    );
  } catch (e) {
    console.warn('Audit log failed:', e.message);
  }
}
