import crypto from 'crypto';
import { query } from './db/pool.js';

export function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

export async function getLatestRate(establishmentId) {
  const { rows } = await query(
    'SELECT usd_to_ves, updated_at FROM exchange_rates WHERE establishment_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 1',
    [establishmentId]
  );
  return rows[0] || null;
}

export function toNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}