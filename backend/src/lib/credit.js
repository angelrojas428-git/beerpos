// Cuentas por Cobrar / Fiado — credit service.
//
// Source of truth is the immutable `credit_ledger` (signed entries). The
// per-client `credit_balance_usd` is a cached running balance updated inside the
// same transaction. Every operation is atomic (row lock on the client) so the
// credit limit cannot be exceeded under concurrency.
//
// Entry types (signed amount_usd: + increases debt, - decreases it):
//   CHARGE      sale on credit
//   PAYMENT     collection (abono)
//   CREDIT_NOTE return / goodwill discount
//   ADJUSTMENT  generic correction (owner only, reason required)
//   VOID        reversal of a specific entry (owner only)
import { pool, query } from '../db/pool.js';
import { auditLog } from './audit.js';
import { getLatestRate } from '../lib.js';

class CreditError extends Error {
  constructor(message, status = 400, code = 'credit_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function asPositiveNumber(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CreditError(`${field} debe ser un número mayor a 0`, 400, 'invalid_amount');
  }
  return round2(n);
}

/** Fetch a client row for a given establishment (throws 404 if missing). */
async function loadClient(clientId, establishmentId) {
  const { rows } = await query(
    `SELECT id, establishment_id, full_name, credit_limit_usd, credit_balance_usd, credit_hold_reason
       FROM clients WHERE id = $1 AND establishment_id = $2`,
    [clientId, establishmentId]
  );
  if (!rows[0]) throw new CreditError('Cliente no encontrado', 404, 'client_not_found');
  return rows[0];
}

/**
 * Register a sale on credit.
 * @param {{clientId, establishmentId, staffId, amountUsd, quantity?, amountVes?, exchangeRate?, referenceType?, referenceId?, note?, ip?, override?:boolean, overrideReason?:string}} p
 */
export async function creditSale(p) {
  const establishmentId = Number(p.establishmentId);
  const amount = asPositiveNumber(p.amountUsd, 'amount_usd');
  const quantity = Number.isInteger(Number(p.quantity)) ? Number(p.quantity) : 1;

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [client] } = await db.query(
      `SELECT id, full_name, credit_limit_usd, credit_balance_usd, credit_hold_reason
         FROM clients WHERE id = $1 AND establishment_id = $2 FOR UPDATE`,
      [p.clientId, establishmentId]
    );
    if (!client) throw new CreditError('Cliente no encontrado', 404, 'client_not_found');

    const limit = round2(client.credit_limit_usd);
    const balance = round2(client.credit_balance_usd);
    const projected = round2(balance + amount);

    if (client.credit_hold_reason) {
      throw new CreditError(`Cliente bloqueado: ${client.credit_hold_reason}`, 409, 'credit_hold');
    }
    if (limit <= 0) {
      throw new CreditError('Este cliente no tiene crédito (fiado) habilitado.', 409, 'no_credit');
    }
    if (projected > limit) {
      const available = round2(limit - balance);
      const error = new CreditError(
        `Límite de crédito excedido: disponible $${available.toFixed(2)}, consumo $${amount.toFixed(2)}.`,
        409,
        'limit_exceeded'
      );
      error.details = { limit, balance, available, amount };
      throw error;
    }
    if (p.override === true && projected > limit && !p.overrideReason) {
      throw new CreditError('El override de límite requiere un motivo.', 400, 'reason_required');
    }

    const rate = p.exchangeRate != null ? Number(p.exchangeRate) : null;
    const amountVes = p.amountVes != null ? Number(p.amountVes) : (rate ? round2(amount * rate) : null);

    const tx = await db.query(
      `INSERT INTO transactions
         (establishment_id, client_id, staff_id, transaction_type, quantity, amount_usd, amount_ves, payment_method)
       VALUES ($1, $2, $3, 'CREDIT_SALE', $4, $5, $6, 'credit')
       RETURNING id`,
      [establishmentId, client.id, p.staffId ?? null, quantity, amount, amountVes]
    );

    await db.query(
      `INSERT INTO credit_ledger
         (establishment_id, client_id, entry_type, amount_usd, balance_after_usd, amount_ves, exchange_rate,
          payment_method, reference_type, reference_id, note, staff_id)
       VALUES ($1, $2, 'CHARGE', $3, $4, $5, $6, 'credit', 'transaction', $7, $8, $9)`,
      [establishmentId, client.id, amount, projected, amountVes, rate, tx.rows[0].id, p.note ?? null, p.staffId ?? null]
    );

    await db.query(
      `UPDATE clients SET credit_balance_usd = $1 WHERE id = $2`,
      [projected, client.id]
    );

    await db.query('COMMIT');

    await auditLog({
      establishmentId,
      clientId: client.id,
      staffId: p.staffId ?? null,
      action: p.override === true ? 'credit_override' : 'credit_sale',
      entityType: 'client',
      entityId: client.id,
      details: {
        amount_usd: amount,
        balance_after_usd: projected,
        limit,
        transaction_id: tx.rows[0].id,
        override: p.override === true,
        reason: p.overrideReason ?? null,
      },
      ipAddress: p.ip || null,
    });

    return {
      ok: true,
      client_id: client.id,
      charge_usd: amount,
      balance_after_usd: projected,
      credit_limit_usd: limit,
      available_usd: round2(limit - projected),
      transaction_id: tx.rows[0].id,
    };
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    db.release();
  }
}

/**
 * Register a payment / abono against the debt.
 * @param {{clientId, establishmentId, staffId, amountUsd, paymentMethod?, reference?, note?, ip?}} p
 */
export async function creditPayment(p) {
  const establishmentId = Number(p.establishmentId);
  const requested = asPositiveNumber(p.amountUsd, 'amount_usd');
  const method = p.paymentMethod || 'manual';

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [client] } = await db.query(
      `SELECT id, credit_balance_usd FROM clients WHERE id = $1 AND establishment_id = $2 FOR UPDATE`,
      [p.clientId, establishmentId]
    );
    if (!client) throw new CreditError('Cliente no encontrado', 404, 'client_not_found');

    const balance = round2(client.credit_balance_usd);
    if (balance <= 0) {
      throw new CreditError('El cliente no tiene deuda pendiente.', 409, 'no_debt');
    }
    if (requested > balance) {
      throw new CreditError(
        `El abono ($${requested.toFixed(2)}) supera la deuda ($${balance.toFixed(2)}).`,
        409,
        'overpayment'
      );
    }
    const applied = requested; // capped by validation
    const newBalance = round2(balance - applied);

    const tx = await db.query(
      `INSERT INTO transactions
         (establishment_id, client_id, staff_id, transaction_type, quantity, amount_usd, payment_method)
       VALUES ($1, $2, $3, 'CREDIT_PAYMENT', 0, $4, $5)
       RETURNING id`,
      [establishmentId, client.id, p.staffId ?? null, applied, method]
    );

    await db.query(
      `INSERT INTO credit_ledger
         (establishment_id, client_id, entry_type, amount_usd, balance_after_usd,
          payment_method, reference_type, reference_id, note, staff_id)
       VALUES ($1, $2, 'PAYMENT', $3, $4, $5, 'transaction', $6, $7, $8)`,
      [establishmentId, client.id, -applied, newBalance, method, tx.rows[0].id, p.note ?? p.reference ?? null, p.staffId ?? null]
    );

    await db.query(`UPDATE clients SET credit_balance_usd = $1 WHERE id = $2`, [newBalance, client.id]);

    await db.query('COMMIT');

    await auditLog({
      establishmentId,
      clientId: client.id,
      staffId: p.staffId ?? null,
      action: 'credit_payment',
      entityType: 'client',
      entityId: client.id,
      details: { amount_usd: applied, balance_after_usd: newBalance, payment_method: method, reference: p.reference ?? null },
      ipAddress: p.ip || null,
    });

    return {
      ok: true,
      client_id: client.id,
      paid_usd: applied,
      balance_after_usd: newBalance,
      transaction_id: tx.rows[0].id,
    };
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    db.release();
  }
}

/** Set a client's credit limit (owner action). 0 disables credit. */
export async function setCreditLimit(p) {
  const establishmentId = Number(p.establishmentId);
  const limit = p.creditLimitUsd != null ? round2(p.creditLimitUsd) : null;
  if (limit == null || !Number.isFinite(limit) || limit < 0) {
    throw new CreditError('credit_limit_usd debe ser un número >= 0', 400, 'invalid_amount');
  }
  const client = await loadClient(p.clientId, establishmentId);
  const { rows } = await query(
    `UPDATE clients SET credit_limit_usd = $1 WHERE id = $2 RETURNING id, credit_limit_usd, credit_balance_usd`,
    [limit, p.clientId]
  );
  await auditLog({
    establishmentId,
    clientId: client.id,
    staffId: p.staffId ?? null,
    action: 'credit_limit_changed',
    entityType: 'client',
    entityId: client.id,
    details: { credit_limit_usd: limit, by: p.staffId ?? null },
    ipAddress: p.ip || null,
  });
  return { ok: true, credit_limit_usd: rows[0].credit_limit_usd, credit_balance_usd: rows[0].credit_balance_usd };
}

/** Manually block/unblock a client's credit (hold reason). */
export async function setCreditHold(p) {
  const establishmentId = Number(p.establishmentId);
  const reason = p.reason ? String(p.reason).trim().slice(0, 120) : null;
  const client = await loadClient(p.clientId, establishmentId);
  await query(`UPDATE clients SET credit_hold_reason = $1 WHERE id = $2`, [reason, p.clientId]);
  await auditLog({
    establishmentId,
    clientId: client.id,
    staffId: p.staffId ?? null,
    action: reason ? 'credit_hold_set' : 'credit_hold_cleared',
    entityType: 'client',
    entityId: client.id,
    details: { reason },
    ipAddress: p.ip || null,
  });
  return { ok: true, credit_hold_reason: reason };
}

async function applyCompensatingEntry(p, { entryType, sign, action }) {
  const establishmentId = Number(p.establishmentId);
  const amount = asPositiveNumber(p.amountUsd, 'amount_usd');
  const note = p.note ? String(p.note).trim() : null;
  if (!note) throw new CreditError('El motivo (note) es obligatorio.', 400, 'reason_required');

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [client] } = await db.query(
      `SELECT id, credit_balance_usd FROM clients WHERE id = $1 AND establishment_id = $2 FOR UPDATE`,
      [p.clientId, establishmentId]
    );
    if (!client) throw new CreditError('Cliente no encontrado', 404, 'client_not_found');

    const signed = sign * amount;
    const newBalance = round2(round2(client.credit_balance_usd) + signed);

    let relatedId = p.relatedLedgerId ?? null;
    if (entryType === 'CREDIT_NOTE' || entryType === 'VOID') {
      if (!relatedId) throw new CreditError('Debe indicar el asiento de referencia (related_ledger_id).', 400, 'reference_required');
      const { rows: [orig] } = await db.query(
        `SELECT id, client_id FROM credit_ledger WHERE id = $1 AND client_id = $2`,
        [relatedId, client.id]
      );
      if (!orig) throw new CreditError('El asiento de referencia no pertenece a este cliente.', 400, 'bad_reference');
    }

    const { rows: [entry] } = await db.query(
      `INSERT INTO credit_ledger
         (establishment_id, client_id, entry_type, amount_usd, balance_after_usd,
          note, related_ledger_id, staff_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [establishmentId, client.id, entryType, signed, newBalance, note, relatedId, p.staffId ?? null]
    );

    await db.query(`UPDATE clients SET credit_balance_usd = $1 WHERE id = $2`, [newBalance, client.id]);
    await db.query('COMMIT');

    await auditLog({
      establishmentId,
      clientId: client.id,
      staffId: p.staffId ?? null,
      action,
      entityType: 'client',
      entityId: client.id,
      details: { amount_usd: signed, balance_after_usd: newBalance, note, related_ledger_id: relatedId, entry_id: entry.id },
      ipAddress: p.ip || null,
    });

    return { ok: true, entry_id: entry.id, amount_usd: signed, balance_after_usd: newBalance };
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    db.release();
  }
}

/** Owner adjustment (+/-), reason required. */
export function creditAdjust(p) {
  const amount = Number(p.amountUsd);
  const sign = amount < 0 ? -1 : 1;
  return applyCompensatingEntry({ ...p, amountUsd: Math.abs(amount) }, { entryType: 'ADJUSTMENT', sign, action: 'credit_adjusted' });
}

/** Owner credit note (reduces debt), references the original charge. */
export function creditNote(p) {
  return applyCompensatingEntry(p, { entryType: 'CREDIT_NOTE', sign: -1, action: 'credit_note' });
}

/** Owner void of a specific ledger entry (reverses it). */
export async function voidEntry(p) {
  const establishmentId = Number(p.establishmentId);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows: [orig] } = await db.query(
      `SELECT id, client_id, amount_usd FROM credit_ledger WHERE id = $1 AND establishment_id = $2 FOR UPDATE`,
      [p.entryId, establishmentId]
    );
    if (!orig) throw new CreditError('Asiento no encontrado', 404, 'entry_not_found');
    if (orig.entry_type === 'VOID') throw new CreditError('No se puede anular una anulación.', 400, 'cannot_void_void');

    const { rows: [client] } = await db.query(
      `SELECT credit_balance_usd FROM clients WHERE id = $1 FOR UPDATE`,
      [orig.client_id]
    );
    const signed = -Number(orig.amount_usd);
    const newBalance = round2(round2(client.credit_balance_usd) + signed);

    const note = p.note ? String(p.note).trim() : `Anulación de asiento #${orig.id}`;
    const { rows: [entry] } = await db.query(
      `INSERT INTO credit_ledger
         (establishment_id, client_id, entry_type, amount_usd, balance_after_usd, note, related_ledger_id, staff_id)
       VALUES ($1, $2, 'VOID', $3, $4, $5, $6, $7) RETURNING id`,
      [establishmentId, orig.client_id, signed, newBalance, note, orig.id, p.staffId ?? null]
    );
    await db.query(`UPDATE clients SET credit_balance_usd = $1 WHERE id = $2`, [newBalance, orig.client_id]);
    await db.query('COMMIT');

    await auditLog({
      establishmentId,
      clientId: orig.client_id,
      staffId: p.staffId ?? null,
      action: 'credit_voided',
      entityType: 'client',
      entityId: orig.client_id,
      details: { voided_entry_id: orig.id, void_entry_id: entry.id, amount_usd: signed, balance_after_usd: newBalance, note },
      ipAddress: p.ip || null,
    });

    return { ok: true, void_entry_id: entry.id, amount_usd: signed, balance_after_usd: newBalance };
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    db.release();
  }
}

/** Statement of account (ledger entries) for a client. */
export async function getStatement(establishmentId, clientId, { limit = 200, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT id, entry_type, amount_usd, balance_after_usd, amount_ves, exchange_rate,
            payment_method, note, related_ledger_id, staff_id, created_at
       FROM credit_ledger
      WHERE establishment_id = $1 AND client_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3 OFFSET $4`,
    [establishmentId, clientId, limit, offset]
  );
  const { rows: [client] } = await query(
    `SELECT id, full_name, credit_limit_usd, credit_balance_usd FROM clients WHERE id = $1 AND establishment_id = $2`,
    [clientId, establishmentId]
  );
  return { client: client || null, entries: rows };
}

/**
 * Aging (FIFO): allocate each payment to the oldest outstanding charges.
 * Returns buckets { corriente, d31_60, d61_90, d90_plus, total } per client.
 */
export async function getAging(establishmentId) {
  const { rows: entries } = await query(
    `SELECT id, client_id, entry_type, amount_usd, created_at
       FROM credit_ledger
      WHERE establishment_id = $1
      ORDER BY client_id, created_at ASC, id ASC`,
    [establishmentId]
  );

  const byClient = new Map();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  for (const e of entries) {
    const c = byClient.get(e.client_id) || { charges: [], payments: [] };
    const amt = Number(e.amount_usd);
    if (e.entry_type === 'CHARGE') c.charges.push({ amount: amt, at: new Date(e.created_at).getTime() });
    else if (amt < 0) c.payments.push(-amt); // positive payment amount
    byClient.set(e.client_id, c);
  }

  const out = [];
  for (const [clientId, c] of byClient) {
    const buckets = { corriente: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
    let pool = c.payments.reduce((a, b) => a + b, 0);
    for (const charge of c.charges) {
      let remaining = charge.amount;
      if (pool > 0) {
        const applied = Math.min(remaining, pool);
        remaining -= applied;
        pool -= applied;
      }
      if (remaining > 0) {
        const ageDays = Math.floor((now - charge.at) / DAY);
        if (ageDays <= 30) buckets.corriente += remaining;
        else if (ageDays <= 60) buckets.d31_60 += remaining;
        else if (ageDays <= 90) buckets.d61_90 += remaining;
        else buckets.d90_plus += remaining;
      }
    }
    buckets.total = round2(buckets.corriente + buckets.d31_60 + buckets.d61_90 + buckets.d90_plus);
    out.push({ client_id: clientId, ...buckets });
  }
  return out;
}

export { CreditError };