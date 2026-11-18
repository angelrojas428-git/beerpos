import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Pool tuning (overridable via env). Sensible defaults for a small/medium SaaS.
// - max: concurrent connections
// - idleTimeoutMillis: close idle clients after this long
// - connectionTimeoutMillis: fail fast if a connection can't be acquired
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS) || 30000,
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONN_MS) || 5000,
});

// Prevent an idle-client error from becoming an unhandled 'error' event (crashes the process).
pool.on('error', (err) => {
  console.error('Unexpected PG pool error:', err.message);
});

export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  if (process.env.DEBUG_SQL === '1') {
    console.log('executed query', { text, duration: Date.now() - start, rows: res.rowCount });
  }
  return res;
}