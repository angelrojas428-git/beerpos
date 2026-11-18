// Offsite backup helper for S3-compatible storage.
//
// Usage (from backend/):
//   node scripts/backup-s3.js                 # list backup groups in the bucket
//   node scripts/backup-s3.js --restore <ts>  # download a group into ./backups
//
// Restore downloads the JSON table files into backend/backups/<timestamp>_<table>.json
// so they can be inspected or imported into Postgres manually.
//
// Required env (see .env.example):
//   S3_BACKUP_BUCKET, S3_BACKUP_ENDPOINT (non-AWS), S3_BACKUP_REGION,
//   S3_BACKUP_PREFIX, S3_BACKUP_ACCESS_KEY_ID / S3_BACKUP_SECRET_ACCESS_KEY
import path from 'path';
import { fileURLToPath } from 'url';
import { isS3Configured, listS3Backups, downloadS3BackupGroup } from '../src/lib/s3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKUP_DIR = path.resolve(__dirname, '../backups');

async function main() {
  if (!isS3Configured()) {
    console.error('S3 offsite backup is not configured. Set S3_BACKUP_BUCKET (and credentials) first.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const restoreIdx = args.indexOf('--restore');

  if (restoreIdx !== -1) {
    const timestamp = args[restoreIdx + 1];
    if (!timestamp) {
      console.error('Usage: node scripts/backup-s3.js --restore <timestamp>');
      process.exit(1);
    }
    console.log(`Downloading backup group ${timestamp} -> ${BACKUP_DIR}`);
    const result = await downloadS3BackupGroup(timestamp, BACKUP_DIR);
    if (result.skipped) {
      console.error('S3 offsite backup is not configured.');
      process.exit(1);
    }
    console.log(`Downloaded ${result.downloaded} file(s): ${result.files.join(', ')}`);
    if (result.errors?.length) console.error('Errors:', result.errors);
    return;
  }

  const groups = await listS3Backups();
  if (groups.length === 0) {
    console.log('No backups found in the bucket.');
    return;
  }
  console.log(`Backups in bucket (${groups.length} group(s)):`);
  for (const g of groups) {
    console.log(`  ${g.timestamp}  (${g.files.length} tables)`);
  }
}

main().catch((err) => {
  console.error('backup-s3 failed:', err);
  process.exit(1);
});