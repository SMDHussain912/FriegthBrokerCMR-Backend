const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);
const stat = promisify(fs.stat);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);

// S3 Client (lazy-loaded)
let s3Client = null;
let s3Bucket = null;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/tiff',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
]);

const STORAGE_DIR = process.env.STORAGE_PATH || path.join(__dirname, '..', 'storage');
const STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || 'local';

const S3_CONFIG = {
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  bucket: process.env.S3_BUCKET,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true'
};

class StorageError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function initS3Client() {
  if (s3Client) return s3Client;
  if (STORAGE_PROVIDER !== 's3' && STORAGE_PROVIDER !== 'minio') return null;
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: S3_CONFIG.region,
      endpoint: S3_CONFIG.endpoint,
      credentials: {
        accessKeyId: S3_CONFIG.accessKeyId,
        secretAccessKey: S3_CONFIG.secretAccessKey
      },
      forcePathStyle: S3_CONFIG.forcePathStyle
    });
    s3Bucket = S3_CONFIG.bucket;
    const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, getSignedUrl } = require('@aws-sdk/client-s3');
    const { getSignedUrl: getSignedUrlFn } = require('@aws-sdk/s3-request-presigner');
    global.S3Commands = { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, getSignedUrl: getSignedUrlFn };
    return s3Client;
  } catch (err) {
    console.error('Failed to initialize S3 client:', err.message);
    return null;
  }
}

function isS3Storage() {
  return (STORAGE_PROVIDER === 's3' || STORAGE_PROVIDER === 'minio') && !!s3Client;
}

function ensureStorageDir() {
  if (isS3Storage()) return Promise.resolve();
  return mkdir(STORAGE_DIR, { recursive: true });
}

function safeFilename(originalFilename) {
  const name = path.basename(originalFilename);
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function generateStorageKey(originalFilename, mimeType) {
  const timestamp = Date.now();
  const random = crypto.randomBytes(16).toString('hex');
  const ext = path.extname(safeFilename(originalFilename)) || '';
  return `documents/${timestamp}/${random}${ext}`;
}

async function validateFile(fileBuffer, originalFilename, mimeType) {
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new StorageError('EMPTY_FILE', 'File is empty.', 400);
  }
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw new StorageError('FILE_TOO_LARGE', `File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)} MB limit.`, 400);
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new StorageError('INVALID_MIME_TYPE', `MIME type ${mimeType} is not allowed.`, 400);
  }
  const safeName = safeFilename(originalFilename);
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new StorageError('INVALID_FILENAME', 'Invalid filename.', 400);
  }
  await validateMagicBytes(fileBuffer, mimeType);
}

async function validateMagicBytes(buffer, mimeType) {
  if (buffer.length < 4) return;
  const header = buffer.subarray(0, 8);
  const hex = header.toString('hex').toUpperCase();
  const magicBytes = {
    'application/pdf': ['25504446'],
    'image/png': ['89504E470D0A1A0A'],
    'image/jpeg': ['FFD8FF'],
    'image/jpg': ['FFD8FF'],
    'image/tiff': ['49492A00', '4D4D002A'],
    'application/msword': ['D0CF11E0A1B11AE1'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['504B0304', '504B0506', '504B0708'],
    'text/plain': []
  };
  const expectedMagic = magicBytes[mimeType];
  if (!expectedMagic || expectedMagic.length === 0) return;
  const matches = expectedMagic.some(magic => hex.startsWith(magic));
  if (!matches) {
    throw new StorageError('INVALID_FILE_CONTENT', `File content does not match declared MIME type ${mimeType}.`, 400);
  }
}

async function uploadFile(buffer, originalFilename, mimeType, metadata = {}) {
  await validateFile(buffer, originalFilename, mimeType);
  await ensureStorageDir();
  const storageKey = generateStorageKey(originalFilename, mimeType);
  const safeName = safeFilename(originalFilename);
  const uploadMetadata = {
    originalFilename: safeName,
    mimeType,
    fileSize: buffer.length,
    uploadedAt: new Date().toISOString(),
    uploadedBy: metadata.uploadedBy || 'unknown',
    companyId: metadata.companyId || 'unknown',
    ...metadata
  };
  if (isS3Storage()) {
    await uploadToS3(storageKey, buffer, mimeType, uploadMetadata);
  } else {
    await uploadToLocal(storageKey, buffer);
  }
  return {
    storageKey,
    originalFilename: safeName,
    mimeType,
    fileSize: buffer.length,
    uploadedAt: new Date(),
    provider: STORAGE_PROVIDER
  };
}

async function uploadToS3(storageKey, buffer, mimeType, metadata) {
  if (!s3Client) initS3Client();
  const { PutObjectCommand } = global.S3Commands;
  const command = new PutObjectCommand({
    Bucket: s3Bucket,
    Key: storageKey,
    Body: buffer,
    ContentType: mimeType,
    Metadata: metadata,
    ServerSideEncryption: 'AES256'
  });
  await s3Client.send(command);
}

async function uploadToLocal(storageKey, buffer) {
  const fullPath = path.join(STORAGE_DIR, storageKey);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, buffer);
}

function resolveStoragePath(storageKey) {
  if (isS3Storage()) return storageKey;
  if (typeof storageKey !== 'string' || !storageKey.trim()) {
    throw new StorageError('INVALID_STORAGE_KEY', 'Invalid storage key.', 400);
  }
const normalizedKey = path.normalize(storageKey).replace(/^[\/]+/, '');
  if (normalizedKey.startsWith('..') || normalizedKey.includes('..' + path.sep)) {
    throw new StorageError('INVALID_STORAGE_KEY', 'Invalid storage key.', 400);
  }
  const base = path.resolve(STORAGE_DIR);
  const fullPath = path.resolve(base, normalizedKey);
  if (fullPath !== base && !fullPath.startsWith(base + path.sep)) {
    throw new StorageError('INVALID_STORAGE_KEY', 'Invalid storage key.', 400);
  }
  return fullPath;
}

async function getFile(storageKey) {
  if (isS3Storage()) return await getFileFromS3(storageKey);
  await ensureStorageDir();
  const fullPath = resolveStoragePath(storageKey);
  try {
    await stat(fullPath);
  } catch (err) {
    if (err.code === 'ENOENT') throw new StorageError('FILE_NOT_FOUND', 'Document not found in storage.', 404);
    throw new StorageError('STORAGE_ERROR', 'Unable to access storage.', 500);
  }
  const buffer = await readFile(fullPath);
  const stats = await stat(fullPath);
  return { buffer, fileSize: stats.size, fullPath };
}

async function getFileFromS3(storageKey) {
  if (!s3Client) initS3Client();
  const { GetObjectCommand, HeadObjectCommand } = global.S3Commands;
  try {
    const headCommand = new HeadObjectCommand({ Bucket: s3Bucket, Key: storageKey });
    const headResult = await s3Client.send(headCommand);
    const getCommand = new GetObjectCommand({ Bucket: s3Bucket, Key: storageKey });
    const getResult = await s3Client.send(getCommand);
    const chunks = [];
    for await (const chunk of getResult.Body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    return { buffer, fileSize: headResult.ContentLength, mimeType: headResult.ContentType, metadata: headResult.Metadata, fullPath: storageKey };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) throw new StorageError('FILE_NOT_FOUND', 'Document not found in storage.', 404);
    throw new StorageError('STORAGE_ERROR', 'Unable to access S3 storage.', 500);
  }
}

async function deleteFile(storageKey) {
  if (isS3Storage()) return await deleteFileFromS3(storageKey);
  await ensureStorageDir();
  const fullPath = resolveStoragePath(storageKey);
  try {
    await unlink(fullPath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw new StorageError('STORAGE_ERROR', 'Unable to delete from storage.', 500);
  }
}

async function deleteFileFromS3(storageKey) {
  if (!s3Client) initS3Client();
  const { DeleteObjectCommand } = global.S3Commands;
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: storageKey }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw new StorageError('STORAGE_ERROR', 'Unable to delete from S3 storage.', 500);
  }
}

async function generateDownloadUrl(storageKey, expirySeconds = 300, options = {}) {
  const { filename, inline = false } = options;
  if (isS3Storage()) return await generateS3SignedUrl(storageKey, expirySeconds, { filename, inline });
  const token = crypto.randomBytes(32).toString('hex');
  return { downloadUrl: `/api/storage/download/${encodeURIComponent(storageKey)}?token=${token}`, expiresIn: expirySeconds, token, provider: 'local' };
}

async function generateS3SignedUrl(storageKey, expirySeconds, options = {}) {
  if (!s3Client) initS3Client();
  const { GetObjectCommand, getSignedUrl } = global.S3Commands;
  const { filename, inline = false } = options;
  const command = new GetObjectCommand({
    Bucket: s3Bucket,
    Key: storageKey,
    ResponseContentDisposition: inline ? `inline; filename="${filename || 'document'}"` : `attachment; filename="${filename || 'document'}"`,
    ResponseContentType: options.contentType
  });
  const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: expirySeconds });
  return { downloadUrl: signedUrl, expiresIn: expirySeconds, provider: 's3' };
}

async function getFileMetadata(storageKey) {
  if (isS3Storage()) {
    if (!s3Client) initS3Client();
    const { HeadObjectCommand } = global.S3Commands;
    try {
      const command = new HeadObjectCommand({ Bucket: s3Bucket, Key: storageKey });
      const result = await s3Client.send(command);
      return { storageKey, fileSize: result.ContentLength, mimeType: result.ContentType, lastModified: result.LastModified, metadata: result.Metadata, etag: result.ETag, provider: 's3' };
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) throw new StorageError('FILE_NOT_FOUND', 'Document not found in storage.', 404);
      throw new StorageError('STORAGE_ERROR', 'Unable to access S3 storage.', 500);
    }
  }
  await ensureStorageDir();
  const fullPath = resolveStoragePath(storageKey);
  try {
    const stats = await stat(fullPath);
    return { storageKey, fileSize: stats.size, lastModified: stats.mtime, provider: 'local' };
  } catch (err) {
    if (err.code === 'ENOENT') throw new StorageError('FILE_NOT_FOUND', 'Document not found in storage.', 404);
    throw new StorageError('STORAGE_ERROR', 'Unable to access storage.', 500);
  }
}

async function listFiles(prefix = '', options = {}) {
  const { maxKeys = 1000, delimiter } = options;
  if (isS3Storage()) {
    if (!s3Client) initS3Client();
    const { ListObjectsV2Command } = global.S3Commands;
    const command = new ListObjectsV2Command({ Bucket: s3Bucket, Prefix: prefix, MaxKeys: maxKeys, Delimiter: delimiter });
    const result = await s3Client.send(command);
    return { files: (result.Contents || []).map(obj => ({ key: obj.Key, size: obj.Size, lastModified: obj.LastModified, etag: obj.ETag })), prefixes: result.CommonPrefixes?.map(p => p.Prefix) || [], isTruncated: result.IsTruncated, nextContinuationToken: result.NextContinuationToken, provider: 's3' };
  }
  await ensureStorageDir();
  const basePath = path.join(STORAGE_DIR, prefix);
  try {
    const files = await readdir(basePath, { withFileTypes: true });
    return { files: files.filter(f => f.isFile()).map(f => { const fullPath = path.join(basePath, f.name); const stats = fs.statSync(fullPath); return { key: path.join(prefix, f.name), size: stats.size, lastModified: stats.mtime, isFile: true }; }), prefixes: files.filter(f => f.isDirectory()).map(f => path.join(prefix, f.name) + '/'), isTruncated: false, provider: 'local' };
  } catch (err) {
    if (err.code === 'ENOENT') return { files: [], prefixes: [], isTruncated: false, provider: 'local' };
    throw new StorageError('STORAGE_ERROR', 'Unable to list files.', 500);
  }
}

async function healthCheck() {
  const checks = { local: false, s3: false, provider: STORAGE_PROVIDER, timestamp: new Date().toISOString() };
  try {
    await ensureStorageDir();
    const testKey = `.health-check-${Date.now()}`;
    const testPath = path.join(STORAGE_DIR, testKey);
    await writeFile(testPath, 'health-check');
    await unlink(testPath);
    checks.local = true;
  } catch (err) { checks.local = false; checks.localError = err.message; }
  if (STORAGE_PROVIDER === 's3' || STORAGE_PROVIDER === 'minio') {
    try {
      initS3Client();
      if (s3Client) {
        const { HeadObjectCommand } = global.S3Commands;
        await s3Client.send(new HeadObjectCommand({ Bucket: s3Bucket, Key: '.health-check-nonexistent' }));
      }
      checks.s3 = false;
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) checks.s3 = true;
      else { checks.s3 = false; checks.s3Error = err.message; }
    }
  }
  return checks;
}

async function cleanupExpiredDocuments(retentionDays = 2555) {
  if (isS3Storage()) return await cleanupExpiredS3(retentionDays);
  return await cleanupExpiredLocal(retentionDays);
}

async function cleanupExpiredLocal(retentionDays) {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let deletedCount = 0;
  async function scanDirectory(dir) {
    try {
      const files = await readdir(dir, { withFileTypes: true });
      for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
          await scanDirectory(fullPath);
          const remaining = await readdir(dir);
          if (remaining.length === 0) await fs.promises.rmdir(dir);
        } else {
          const stats = await stat(fullPath);
          if (stats.mtime < cutoffDate) { await unlink(fullPath); deletedCount++; }
        }
      }
    } catch (err) {}
  }
  await scanDirectory(STORAGE_DIR);
  return { deletedCount, provider: 'local' };
}

async function cleanupExpiredS3(retentionDays) {
  if (!s3Client) initS3Client();
  const { ListObjectsV2Command, DeleteObjectCommand } = global.S3Commands;
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let deletedCount = 0;
  let continuationToken;
  do {
    const command = new ListObjectsV2Command({ Bucket: s3Bucket, MaxKeys: 1000, ContinuationToken: continuationToken });
    const result = await s3Client.send(command);
    if (result.Contents) {
      for (const obj of result.Contents) {
        if (obj.LastModified < cutoffDate) {
          try { await s3Client.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: obj.Key })); deletedCount++; } catch (err) {}
        }
      }
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);
  return { deletedCount, provider: 's3' };
}

function getStorageInfo() {
  return { provider: STORAGE_PROVIDER, storagePath: STORAGE_DIR, maxFileSize: MAX_FILE_SIZE, allowedMimeTypes: Array.from(ALLOWED_MIME_TYPES), productionReady: STORAGE_PROVIDER !== 'local', s3Configured: !!s3Client || (STORAGE_PROVIDER === 's3' || STORAGE_PROVIDER === 'minio'), s3Bucket: s3Bucket, note: STORAGE_PROVIDER === 'local' ? 'Local filesystem storage. Configure AWS S3 or compatible provider for production.' : `Using ${STORAGE_PROVIDER.toUpperCase()} storage.` };
}

if (STORAGE_PROVIDER === 's3' || STORAGE_PROVIDER === 'minio') initS3Client();

module.exports = { StorageError, MAX_FILE_SIZE, ALLOWED_MIME_TYPES, STORAGE_PROVIDER, uploadFile, getFile, getFileMetadata, deleteFile, generateDownloadUrl, listFiles, healthCheck, cleanupExpiredDocuments, getStorageInfo, ensureStorageDir, isS3Storage: () => isS3Storage(), validateMagicBytes };
