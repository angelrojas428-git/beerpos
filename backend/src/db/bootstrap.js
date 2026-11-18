// Automatic, idempotent database bootstrap for platforms without shell access
// (e.g. Render's free web services, which have no SSH and no pre-deploy command).
//
// Two independent steps, each gated:
//   - DB_AUTOINIT=1                     → apply db/schema.sql (safe to re-run)
//   - BOOTSTRAP_ADMIN_NAME + _PIN       → create the platform admin once (if missing)
//   - BOOTSTRAP_ADMIN_ROTATE=1          → also rotate the PIN of the existing admin
//
// This runs at process start, before the HTTP server accepts traffic.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';
import { hashPin, validatePin } from '../lib/pin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, '../../../db/schema.sql');

async function ensureSchema() {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('[bootstrap] schema applied.');
}

async function ensurePlatformAdmin() {
  const name = (process.env.BOOTSTRAP_ADMIN_NAME || '').trim();
  const pin = process.env.BOOTSTRAP_ADMIN_PIN || '';
  if (!name || !pin) return;

  const policy = validatePin(pin);
  if (!policy.ok) {
    console.error(`[bootstrap] BOOTSTRAP_ADMIN_PIN inválido: ${policy.error}`);
    return;
  }

  const { rows } = await pool.query(
    `SELECT id FROM staff WHERE role = 'platform_admin' AND name = $1`,
    [name]
  );

  const rotate = process.env.BOOTSTRAP_ADMIN_ROTATE === '1';

  if (rows.length === 0) {
    const hash = await hashPin(pin);
    await pool.query(
      `INSERT INTO staff (establishment_id, name, pin, role) VALUES (NULL, $1, $2, 'platform_admin')`,
      [name, hash]
    );
    console.log(`[bootstrap] platform admin "${name}" created.`);
    return;
  }

  if (rotate) {
    const hash = await hashPin(pin);
    await pool.query(`UPDATE staff SET pin = $1, active = true WHERE id = $2`, [hash, rows[0].id]);
    console.log(`[bootstrap] platform admin "${name}" PIN rotated.`);
    return;
  }

  console.log(`[bootstrap] platform admin "${name}" already exists (skipping).`);
}

export async function bootstrap() {
  if (process.env.DB_AUTOINIT === '1') {
    try {
      await ensureSchema();
    } catch (e) {
      console.error('[bootstrap] schema init failed:', e.message);
    }
  }

  try {
    await ensurePlatformAdmin();
  } catch (e) {
    console.error('[bootstrap] platform admin bootstrap failed:', e.message);
  }
}