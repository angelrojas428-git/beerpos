// Offsite backup storage for any S3-compatible provider.
//
// Enabled only when S3_BACKUP_BUCKET is set; otherwise every function is a
// graceful no-op so local dev and single-instance deployments keep working
// without cloud credentials.
//
// Layout in the bucket:
//   <prefix>/<timestamp>/<timestamp>_<table>.json
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const s3 = config.s3Backup;

let clientPromise = null;

/** True when offsite backup is configured. */
export function isS3Configured() {
  return Boolean(s3.bucket);
}

/**
 * Builds the object key for a backup file.
 * Normalizes the prefix (no leading/trailing slashes) so callers can pass
 * 'backups', '/backups/' or '' interchangeably.
 */
export function buildS3Key(timestamp, fileName) {
  const prefix = String(s3.prefix ?? 'backups').replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/${timestamp}/${fileName}` : `${timestamp}/${fileName}`;
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { S3Client } = await import('@aws-sdk/client-s3');
      const clientConfig = {
        region: s3.region || 'us-east-1',
        forcePathStyle: s3.forcePathStyle,
      };
      if (s3.endpoint) clientConfig.endpoint = s3.endpoint;
      if (s3.accessKeyId && s3.secretAccessKey) {
        clientConfig.credentials = { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey };
      }
      return new S3Client(clientConfig);
    })().catch((e) => {
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

/**
 * Uploads the JSON files produced by a local backup run to S3.
 * @param {Array<{table:string, rows:number, file:string}>} results entries from runBackup()
 * @param {string} timestamp        backup timestamp group
 * @param {string} localDir         directory holding the local backup files
 * @returns {Promise<{uploaded:number, failed:number, skipped:boolean, errors?:string[]}>}
 */
export async function uploadBackup(results, timestamp, localDir) {
  if (!isS3Configured()) return { uploaded: 0, failed: 0, skipped: true };

  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getClient();
  const errors = [];
  let uploaded = 0;
  let failed = 0;

  for (const r of results || []) {
    if (!r || !r.file) continue;
    const localPath = path.join(localDir, r.file);
    let body;
    try {
      body = fs.readFileSync(localPath);
    } catch (e) {
      failed += 1;
      errors.push(`${r.file}: ${e.message}`);
      continue;
    }
    try {
      await client.send(new PutObjectCommand({
        Bucket: s3.bucket,
        Key: buildS3Key(timestamp, r.file),
        Body: body,
        ContentType: 'application/json',
      }));
      uploaded += 1;
    } catch (e) {
      failed += 1;
      errors.push(`${r.file}: ${e.message}`);
    }
  }

  return { uploaded, failed, skipped: false, ...(errors.length ? { errors } : {}) };
}

/**
 * Lists backup groups (timestamps) present in the bucket.
 * @returns {Promise<Array<{timestamp:string, files:string[]}>>}
 */
export async function listS3Backups() {
  if (!isS3Configured()) return [];
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const client = await getClient();
  const prefix = String(s3.prefix ?? 'backups').replace(/^\/+|\/+$/g, '');
  const listPrefix = prefix ? `${prefix}/` : '';

  const groups = {};
  let continuationToken;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: s3.bucket,
      Prefix: listPrefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of res.Contents || []) {
      const rel = listPrefix && obj.Key.startsWith(listPrefix) ? obj.Key.slice(listPrefix.length) : obj.Key;
      const ts = rel.split('/')[0];
      const fileName = rel.split('/')[1];
      if (!ts || !fileName) continue;
      if (!groups[ts]) groups[ts] = [];
      groups[ts].push(fileName);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return Object.entries(groups)
    .map(([timestamp, files]) => ({ timestamp, files: files.sort() }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Downloads every file of a backup group into destDir (for manual restore).
 * @returns {Promise<{downloaded:number, files:string[], errors?:string[]}>}
 */
export async function downloadS3BackupGroup(timestamp, destDir) {
  if (!isS3Configured()) return { downloaded: 0, files: [], skipped: true };

  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getClient();
  fs.mkdirSync(destDir, { recursive: true });

  const prefix = String(s3.prefix ?? 'backups').replace(/^\/+|\/+$/g, '');
  const listPrefix = prefix ? `${prefix}/${timestamp}/` : `${timestamp}/`;

  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const listed = await client.send(new ListObjectsV2Command({ Bucket: s3.bucket, Prefix: listPrefix }));

  const errors = [];
  const files = [];
  for (const obj of listed.Contents || []) {
    const fileName = obj.Key.slice(listPrefix.length);
    if (!fileName) continue;
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: obj.Key }));
      const buf = await res.Body.transformToByteArray();
      fs.writeFileSync(path.join(destDir, fileName), Buffer.from(buf));
      files.push(fileName);
    } catch (e) {
      errors.push(`${fileName}: ${e.message}`);
    }
  }

  return { downloaded: files.length, files, ...(errors.length ? { errors } : {}) };
}