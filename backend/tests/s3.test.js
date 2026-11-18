import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// These tests cover the config-driven logic of the S3 offsite backup module
// without touching the network: key building, enablement detection, the
// no-op path when unconfigured, and per-file error capture for missing files.

async function loadS3(env) {
  for (const k of [
    'S3_BACKUP_BUCKET', 'S3_BACKUP_ENDPOINT', 'S3_BACKUP_REGION',
    'S3_BACKUP_PREFIX', 'S3_BACKUP_FORCE_PATH_STYLE',
    'S3_BACKUP_ACCESS_KEY_ID', 'S3_BACKUP_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  ]) delete process.env[k];
  Object.assign(process.env, env || {});
  jest.resetModules();
  return import('../src/lib/s3.js');
}

afterEach(() => {
  for (const k of [
    'S3_BACKUP_BUCKET', 'S3_BACKUP_ENDPOINT', 'S3_BACKUP_REGION',
    'S3_BACKUP_PREFIX', 'S3_BACKUP_FORCE_PATH_STYLE',
    'S3_BACKUP_ACCESS_KEY_ID', 'S3_BACKUP_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  ]) delete process.env[k];
});

describe('s3 offsite backup', () => {
  describe('isS3Configured', () => {
    test('false when no bucket is set', async () => {
      const s3 = await loadS3({});
      expect(s3.isS3Configured()).toBe(false);
    });

    test('true when a bucket is set', async () => {
      const s3 = await loadS3({ S3_BACKUP_BUCKET: 'my-bucket' });
      expect(s3.isS3Configured()).toBe(true);
    });
  });

  describe('buildS3Key', () => {
    test('uses the default "backups" prefix', async () => {
      const s3 = await loadS3({ S3_BACKUP_BUCKET: 'b' });
      expect(s3.buildS3Key('2026-11-17T10-00-00-000Z', '2026-11-17T10-00-00-000Z_staff.json'))
        .toBe('backups/2026-11-17T10-00-00-000Z/2026-11-17T10-00-00-000Z_staff.json');
    });

    test('normalizes a custom prefix (strips leading/trailing slashes)', async () => {
      const s3 = await loadS3({ S3_BACKUP_BUCKET: 'b', S3_BACKUP_PREFIX: '/custom/nested/' });
      expect(s3.buildS3Key('ts', 'ts_clients.json')).toBe('custom/nested/ts/ts_clients.json');
    });

    test('omits the prefix segment when prefix is empty', async () => {
      const s3 = await loadS3({ S3_BACKUP_BUCKET: 'b', S3_BACKUP_PREFIX: '' });
      expect(s3.buildS3Key('ts', 'ts_clients.json')).toBe('ts/ts_clients.json');
    });
  });

  describe('uploadBackup', () => {
    test('is a no-op (skipped) when unconfigured', async () => {
      const s3 = await loadS3({});
      const res = await s3.uploadBackup([{ table: 'staff', rows: 1, file: 'x.json' }], 'ts', '.');
      expect(res).toEqual({ uploaded: 0, failed: 0, skipped: true });
    });

    test('captures per-file read errors without throwing', async () => {
      const s3 = await loadS3({ S3_BACKUP_BUCKET: 'b' });
      // Point at a directory that does not contain the file -> readFileSync fails,
      // which must be recorded as a failure rather than aborting the whole run.
      const res = await s3.uploadBackup(
        [{ table: 'staff', rows: 1, file: 'missing.json' }],
        'ts',
        './__no_such_dir__'
      );
      expect(res.skipped).toBe(false);
      expect(res.uploaded).toBe(0);
      expect(res.failed).toBe(1);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]).toContain('missing.json');
    });

    test('empty results upload nothing and do not fail', async () => {
      const s3 = await loadS3({ S3_BACKUP_BUCKET: 'b' });
      const res = await s3.uploadBackup([], 'ts', '.');
      expect(res).toEqual({ uploaded: 0, failed: 0, skipped: false });
    });
  });

  describe('listS3Backups', () => {
    test('returns [] when unconfigured (no network)', async () => {
      const s3 = await loadS3({});
      expect(await s3.listS3Backups()).toEqual([]);
    });
  });
});