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

class StorageError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function ensureStorageDir() {
  return mkdir(STORAGE_DIR, { recursive: true });
}

function safeFilename(originalFilename) {
  // Remove path separators and dangerous characters
  const name = path.basename(originalFilename);
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized;
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
}

async function uploadFile(buffer, originalFilename, mimeType) {
  await validateFile(buffer, originalFilename, mimeType);
  await ensureStorageDir();

  const storageKey = generateStorageKey(originalFilename, mimeType);
  const fullPath = path.join(STORAGE_DIR, storageKey);
  await mkdir(path.dirname(fullPath), { recursive: true });

  await writeFile(fullPath, buffer);

  return {
    storageKey,
    originalFilename: safeFilename(originalFilename),
    mimeType,
    fileSize: buffer.length,
    uploadedAt: new Date()
  };
}

function resolveStoragePath(storageKey) {
  if (typeof storageKey !== 'string' || !storageKey.trim()) {
    throw new StorageError('INVALID_STORAGE_KEY', 'Invalid storage key.', 400);
  }
  const normalizedKey = path.normalize(storageKey).replace(/^([/\\])+/, '');
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
  await ensureStorageDir();
  const fullPath = resolveStoragePath(storageKey);

  try {
    await stat(fullPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new StorageError('FILE_NOT_FOUND', 'Document not found in storage.', 404);
    }
    throw new StorageError('STORAGE_ERROR', 'Unable to access storage.', 500);
  }

  const buffer = await readFile(fullPath);
  const stats = await stat(fullPath);

  return {
    buffer,
    fileSize: stats.size,
    fullPath
  };
}

async function deleteFile(storageKey) {
  await ensureStorageDir();
  const fullPath = resolveStoragePath(storageKey);

  try {
    await unlink(fullPath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    }
    throw new StorageError('STORAGE_ERROR', 'Unable to delete from storage.', 500);
  }
}

function generateDownloadUrl(storageKey, expirySeconds = 300) {
  // In production, this would generate a signed S3 URL.
  // For local storage, we return a server-side endpoint that requires auth.
  const token = crypto.randomBytes(32).toString('hex');
  return {
    downloadUrl: `/api/storage/download/${encodeURIComponent(storageKey)}?token=${token}`,
    expiresIn: expirySeconds,
    token
  };
}

function getStorageInfo() {
  return {
    provider: 'local',
    storagePath: STORAGE_DIR,
    maxFileSize: MAX_FILE_SIZE,
    allowedMimeTypes: Array.from(ALLOWED_MIME_TYPES),
    productionReady: false,
    note: 'Local filesystem storage. Configure AWS S3 or compatible provider for production.'
  };
}

module.exports = {
  StorageError,
  MAX_FILE_SIZE,
  ALLOWED_MIME_TYPES,
  uploadFile,
  getFile,
  deleteFile,
  generateDownloadUrl,
  getStorageInfo,
  ensureStorageDir
};