// One-time migration: hash existing plaintext client access tokens at rest.
// Idempotent: only rows whose access_token is not already a 64-char sha256 hex are updated.
// Existing client QR codes keep working because lookups hash the presented token before comparing.
import { pool } from '../src/db/pool.js';
import { hashAccessToken } from '../src/lib/token.js';

async function main() {
  const { rows } = await pool.query(
    `SELECT id, access_token FROM clients WHERE access_token !~ '^[a-f0-9]{64}$'`
  );
  let migrated = 0;
  for (const r of rows) {
    if (!r.access_token) continue;
    await pool.query(`UPDATE clients SET access_token = $1 WHERE id = $2`, [
      hashAccessToken(r.access_token),
      r.id,
    ]);
    migrated++;
  }
  console.log(`Token hash migration complete: ${migrated} client token(s) hashed.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Token hash migration failed:', err);
  process.exit(1);
});