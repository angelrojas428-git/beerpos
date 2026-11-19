// Centralized configuration from environment variables
import dotenv from 'dotenv';
dotenv.config();

const isProd = process.env.NODE_ENV === 'production';

// Resolve the CORS origin:
//   1. explicit CORS_ORIGIN (single origin or comma-separated list), unless it's "*";
//   2. otherwise fall back to Render's injected public URL (RENDER_EXTERNAL_URL),
//      so a fresh free deploy works with zero manual config.
function resolveCorsRaw() {
  const explicit = (process.env.CORS_ORIGIN || '').trim();
  if (explicit && explicit !== '*') return explicit;
  const renderUrl = (process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (renderUrl && renderUrl !== '*') return renderUrl;
  return explicit;
}
const corsRaw = resolveCorsRaw();

// In production, refuse to boot with insecure defaults.
if (isProd) {
  const problems = [];
  if (!corsRaw || corsRaw === '*') {
    problems.push('CORS_ORIGIN debe fijarse a uno o más orígenes reales (no "*") en producción.');
  }
  if (problems.length) {
    console.error('FATAL: configuración de producción inválida:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
}

// Accepts a single origin or a comma-separated list; returns string | string[] | undefined.
function parseCorsOrigin(raw) {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes(',')) {
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return trimmed;
}

export const config = {
  isProd,
  port: Number(process.env.PORT) || 3001,
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/beerpos',
  // In dev, default to '*' for local tooling (BrowserSync). In prod, fail-fast above guarantees a real value.
  corsOrigin: parseCorsOrigin(corsRaw) || (isProd ? undefined : '*'),
  // Number of reverse proxies in front of the app (0 = direct). Set TRUST_PROXY=1 behind Caddy/Nginx.
  trustProxy: Number(process.env.TRUST_PROXY) || 0,
  // JWT_SECRET is reserved for future use; no insecure default.
  jwtSecret: process.env.JWT_SECRET || '',
  sessionTtlMs: Number(process.env.SESSION_TTL_MS) || 8 * 3600 * 1000,
  fastSaleExpiryMinutes: Number(process.env.FAST_SALE_EXPIRY_MINUTES) || 15,
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX) || 60,
  tokenRotationLimitWindowMs: Number(process.env.TOKEN_ROTATION_LIMIT_WINDOW_MS) || 60 * 1000,
  tokenRotationLimitMax: Number(process.env.TOKEN_ROTATION_LIMIT_MAX) || 10,
  authLimitWindowMs: Number(process.env.AUTH_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  authLimitMax: Number(process.env.AUTH_LIMIT_MAX) || 10,
  redeemLimitWindowMs: Number(process.env.REDEEM_LIMIT_WINDOW_MS) || 60 * 1000,
  redeemLimitMax: Number(process.env.REDEEM_LIMIT_MAX) || 30,
  fastSaleLimitWindowMs: Number(process.env.FAST_SALE_LIMIT_WINDOW_MS) || 60 * 1000,
  fastSaleLimitMax: Number(process.env.FAST_SALE_LIMIT_MAX) || 20,
  // Offsite backups to any S3-compatible storage (AWS S3, Cloudflare R2,
  // Backblaze B2, DigitalOcean Spaces, MinIO). Disabled unless a bucket is set.
  s3Backup: {
    bucket: process.env.S3_BACKUP_BUCKET || '',
    endpoint: process.env.S3_BACKUP_ENDPOINT || '',
    region: process.env.S3_BACKUP_REGION || 'us-east-1',
    prefix: process.env.S3_BACKUP_PREFIX ?? 'backups',
    forcePathStyle: (process.env.S3_BACKUP_FORCE_PATH_STYLE || 'true') !== 'false',
    accessKeyId: process.env.S3_BACKUP_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_BACKUP_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '',
  },
};