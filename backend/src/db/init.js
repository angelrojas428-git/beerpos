import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const schemaPath = path.resolve(__dirname, '../../../db/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('Database schema initialized successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('DB init failed:', err);
  process.exit(1);
});
