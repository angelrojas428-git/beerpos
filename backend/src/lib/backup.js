import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db/pool.js';
import { isS3Configured, uploadBackup } from './s3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKUP_DIR = path.resolve(__dirname, '../../backups');
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '7', 10);

const TABLES = [
  'establishments',
  'staff',
  'exchange_rates',
  'clients',
  'transactions',
  'fast_redemptions',
  'client_orders',
  'audit_log',
];

/**
 * Ensures the backups directory exists.
 */
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

/**
 * Rotates old backups, keeping only MAX_BACKUPS most recent.
 */
function rotateBackups() {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const f of files.slice(MAX_BACKUPS)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
    } catch (e) {
      console.warn(`Could not remove old backup ${f.name}: ${e.message}`);
    }
  }
}

/**
 * Exports a single table to a JSON file.
 */
async function exportTable(tableName, timestamp) {
  const { rows } = await query(`SELECT * FROM ${tableName} ORDER BY id`);
  const fileName = `${timestamp}_${tableName}.json`;
  const filePath = path.join(BACKUP_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
  return { table: tableName, rows: rows.length, file: fileName };
}

/**
 * Runs a full backup of all tables.
 * Returns an object with results per table.
 */
export async function runBackup() {
  ensureBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];

  for (const table of TABLES) {
    try {
      const result = await exportTable(table, timestamp);
      results.push(result);
      console.log(`[backup] ${result.file}: ${result.rows} rows`);
    } catch (e) {
      console.error(`[backup] Error exporting table ${table}: ${e.message}`);
      results.push({ table, error: e.message });
    }
  }

  rotateBackups();

  const result = { timestamp, backupDir: BACKUP_DIR, results };

  // Offsite copy (no-op unless S3_BACKUP_BUCKET is configured). A failed upload
  // must never fail the local backup, so errors are captured, not thrown.
  if (isS3Configured()) {
    try {
      result.s3 = await uploadBackup(results, timestamp, BACKUP_DIR);
      console.log(`[backup] S3: ${result.s3.uploaded} uploaded, ${result.s3.failed} failed`);
    } catch (e) {
      console.error('[backup] S3 upload failed:', e.message);
      result.s3 = { error: e.message };
    }
  }

  return result;
}

/**
 * Lists available backup files grouped by timestamp.
 */
export function listBackups() {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json'));
  const groups = {};
  for (const f of files) {
    const ts = f.split('_')[0];
    if (!groups[ts]) groups[ts] = [];
    groups[ts].push(f);
  }
  return Object.entries(groups)
    .map(([ts, tables]) => ({ timestamp: ts, tables }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Removes a specific backup timestamp group.
 */
export function removeBackup(timestamp) {
  const dir = path.resolve(BACKUP_DIR);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${timestamp}_`) && f.endsWith('.json'));
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch (e) {
      console.warn(`Could not remove backup ${f}: ${e.message}`);
    }
  }
  return files.length;
}
