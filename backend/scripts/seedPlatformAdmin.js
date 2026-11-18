// Create or update a platform admin (super-admin) with a bcrypt-hashed PIN.
//
// Usage (from backend/):
//   node scripts/seedPlatformAdmin.js <name> <pin>
//
// The platform admin has establishment_id = NULL and role = 'platform_admin',
// so they can manage every establishment from the super-admin console.
import { pool } from '../src/db/pool.js';
import { hashPin, validatePin } from '../src/lib/pin.js';

async function main() {
  const [, , name, pin] = process.argv;
  if (!name || !pin) {
    console.error('Usage: node scripts/seedPlatformAdmin.js <name> <pin>');
    process.exit(1);
  }

  const policy = validatePin(pin);
  if (!policy.ok) {
    console.error('Invalid PIN:', policy.error);
    process.exit(1);
  }

  const hash = await hashPin(pin);

  // Update an existing platform admin with the same name, or insert a new one.
  const { rows } = await pool.query(
    `UPDATE staff SET pin = $1, active = true
       WHERE role = 'platform_admin' AND name = $2
     RETURNING id`,
    [hash, name]
  );

  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO staff (establishment_id, name, pin, role) VALUES (NULL, $1, $2, 'platform_admin')`,
      [name, hash]
    );
    console.log(`Platform admin "${name}" created.`);
  } else {
    console.log(`Platform admin "${name}" updated (PIN rotated).`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('seedPlatformAdmin failed:', err);
  process.exit(1);
});