// LOCAL DEVELOPMENT ONLY — seeds demo data (establishment + owner + exchange rate).
//
// NEVER run this in production: it creates a weak default PIN (1234).
//
// Usage (from backend/):
//   node scripts/seedDemo.js
import { pool } from '../src/db/pool.js';
import { hashPin } from '../src/lib/pin.js';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Demo establishment (only if none exists).
    const existing = await client.query('SELECT id FROM establishments ORDER BY id LIMIT 1');
    let estId;
    if (existing.rows.length === 0) {
      const est = await client.query(
        `INSERT INTO establishments (name, owner_name, phone, beer_price_usd)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        ['Tasca Demo', 'Admin', '0000000000', 1.50]
      );
      estId = est.rows[0].id;
    } else {
      estId = existing.rows[0].id;
    }

    // Demo exchange rate (only if missing).
    const rate = await client.query(
      'SELECT 1 FROM exchange_rates WHERE establishment_id = $1 LIMIT 1',
      [estId]
    );
    if (rate.rows.length === 0) {
      await client.query(
        'INSERT INTO exchange_rates (establishment_id, usd_to_ves) VALUES ($1, $2)',
        [estId, 36.50]
      );
    }

    // Demo owner with weak PIN (dev only).
    const owner = await client.query(
      'SELECT id FROM staff WHERE establishment_id = $1 AND name = $2',
      [estId, 'Admin']
    );
    if (owner.rows.length === 0) {
      const hash = await hashPin('1234');
      await client.query(
        `INSERT INTO staff (establishment_id, name, pin, role) VALUES ($1, $2, $3, 'owner')`,
        [estId, 'Admin', hash]
      );
    }

    await client.query('COMMIT');
    console.log(`Demo data ready (establishment ${estId}, owner "Admin" / PIN 1234).`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('seedDemo failed:', err);
  process.exit(1);
});