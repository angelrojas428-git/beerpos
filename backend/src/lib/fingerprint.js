import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY = process.env.FINGERPRINT_ENCRYPTION_KEY;

if (!KEY) {
  console.error('FATAL: FINGERPRINT_ENCRYPTION_KEY no está configurada en .env. Los templates biométricos no funcionarán.');
  console.error('Genere una clave con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// Accept either a 64-char hex key (used as-is, 32 bytes — backward compatible) or any
// other string (hashed to 32 bytes via sha256, so PaaS-generated secrets work too).
const KEY_BUFFER = /^[a-f0-9]{64}$/i.test(KEY)
  ? Buffer.from(KEY, 'hex')
  : crypto.createHash('sha256').update(KEY).digest();

/**
 * Encrypts a fingerprint template before storing it in the database.
 * Fingerprint templates are biometric data and must never be stored in plain text.
 */
export function encryptFingerprintTemplate(template) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY_BUFFER, iv);
  const encrypted = Buffer.concat([cipher.update(template, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypts a fingerprint template from the database.
 */
export function decryptFingerprintTemplate(encrypted) {
  const data = Buffer.from(encrypted, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encryptedText = data.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY_BUFFER, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
}

export { KEY_BUFFER as FINGERPRINT_KEY_BUFFER };
