const mongoose = require('mongoose');
const Carrier = require('../models/Carrier');
const CarrierDocument = require('../models/CarrierDocument');
const { StorageError, uploadFile, getFile, deleteFile, generateDownloadUrl } = require('./storageService');

const MAX_AUDIT_ENTRIES = 100;
const DOCUMENT_TYPES = new Set([
  'CERTIFICATE_OF_INSURANCE',
  'AUTO_LIABILITY',
  'GENERAL_LIABILITY',
  'CARGO_INSURANCE',
  'WORKERS_COMPENSATION',
  'OPERATING_AUTHORITY',
  'W9',
  'OTHER'
]);

const DOCUMENT_VERIFICATION_STATUSES = new Set(['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED']);

class DocumentApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function mapDocumentError(error) {
  if (error instanceof DocumentApiError) return error;
  if (error instanceof StorageError) {
    return new DocumentApiError(error.status, error.code, error.message);
  }
  if (error.name === 'CastError') {
    return new DocumentApiError(400, 'INVALID_ID', 'Invalid document or carrier ID.');
  }
  if (error.name === 'ValidationError') {
    return new DocumentApiError(400, 'VALIDATION_ERROR', error.message);
  }
  if (error.code === 11000) {
    return new DocumentApiError(409, 'DUPLICATE_DOCUMENT', 'A document with this storage key already exists.');
  }
  return error;
}

function assertCompanyContext(req) {
  if (req.isDemoMode) {
    throw new DocumentApiError(403, 'DEMO_READ_ONLY', 'Demo documents are read-only.');
  }
  if (!req.companyId || !req.membership) {
    throw new DocumentApiError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertCompanyRole(req, action) {
  assertCompanyContext(req);
  const allowedRoles = req.company?.type === 'carrier'
    ? ['carrier_owner', 'carrier_admin']
    : ['broker_owner', 'broker_admin', 'broker'];
  if (!allowedRoles.includes(req.membership.role)) {
    throw new DocumentApiError(403, 'FORBIDDEN_DOCUMENT_ROLE', `Your company role cannot ${action.toLowerCase()} documents.`);
  }
}

function assertDocumentRole(req, action) {
  assertCompanyContext(req);
  const allowedRoles = ['compliance_officer', 'admin', 'broker_owner', 'broker_admin', 'carrier_owner', 'carrier_admin'];
  if (!allowedRoles.includes(req.membership.role)) {
    throw new DocumentApiError(403, 'FORBIDDEN_DOCUMENT_ROLE', `Your company role cannot ${action.toLowerCase()} documents.`);
  }
}

function validateDocumentType(documentType, customDocumentType) {
  if (!DOCUMENT_TYPES.has(documentType)) {
    throw new DocumentApiError(400, 'INVALID_DOCUMENT_TYPE', `Invalid document type: ${documentType}`);
  }
  if (documentType === 'OTHER' && !customDocumentType) {
    throw new DocumentApiError(400, 'REQUIRED_FIELD', 'customDocumentType is required when documentType is OTHER.');
  }
  if (customDocumentType && customDocumentType.length > 100) {
    throw new DocumentApiError(400, 'INVALID_FIELD', 'customDocumentType must be 100 characters or fewer.');
  }
}

function carrierDocumentScope(req, { includeArchived = false, includeDemo = false } = {}) {
  const filter = {};
  if (!req.isDemoMode) filter.company = req.companyId;
  if (!includeArchived) filter.isArchived = false;
  if (!includeDemo) filter.isDemoData = false;
  return filter;
}

function toPublicDocument(document, { includeAudit = false } = {}) {
  const doc = document.toObject ? document.toObject() : { ...document };
  delete doc.__v;
  if (!includeAudit) delete doc.auditLog;
  return doc;
}

async function listDocuments(req, carrierId, { page = 1, limit = 20, documentType, verificationStatus, isArchived } = {}) {
  assertCompanyContext(req);

  if (!mongoose.Types.ObjectId.isValid(String(carrierId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Carrier ID must be a valid ObjectId.');
  }

  const carrier = await findCarrierForTenant(req, carrierId);
  if (!carrier) {
    const archivedCarrier = await Carrier.findOne({
      _id: carrierId,
      ...(req.isDemoMode ? { isDemoData: true } : { company: req.companyId, isDemoData: false }),
      isArchived: true
    });
    if (archivedCarrier) throw new DocumentApiError(404, 'CARRIER_NOT_FOUND', 'Carrier not found.');
    const otherCarrier = await Carrier.findOne({ _id: carrierId });
    if (otherCarrier) throw new DocumentApiError(403, 'FORBIDDEN_TENANT_ACCESS', 'Carrier does not belong to the active company.');
    throw new DocumentApiError(404, 'CARRIER_NOT_FOUND', 'Carrier not found.');
  }

  const filter = { carrier: carrierId, ...carrierDocumentScope(req) };

  if (documentType) filter.documentType = documentType;
  if (verificationStatus) filter.verificationStatus = verificationStatus;
  if (isArchived !== undefined) filter.isArchived = isArchived === 'true';

  const [total, documents] = await Promise.all([
    CarrierDocument.countDocuments(filter),
    CarrierDocument.find(filter)
      .select('-auditLog')
      .sort({ uploadedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
  ]);

  return {
    success: true,
    count: total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    documents: documents.map(toPublicDocument)
  };
}

async function getDocumentMetadata(req, carrierId, documentId) {
  assertCompanyContext(req);

  if (!mongoose.Types.ObjectId.isValid(String(carrierId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Carrier ID must be a valid ObjectId.');
  }
  if (!mongoose.Types.ObjectId.isValid(String(documentId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Document ID must be a valid ObjectId.');
  }

  const carrier = await findCarrierForTenant(req, carrierId);
  if (!carrier) throw new DocumentApiError(404, 'CARRIER_NOT_FOUND', 'Carrier not found.');

  const document = await findDocumentForTenant(req, documentId);
  if (!document) {
    const archivedDoc = await CarrierDocument.findOne({
      _id: documentId,
      ...carrierDocumentScope(req, { includeArchived: true }),
      carrier: carrierId,
      isArchived: true
    });
    if (archivedDoc) throw new DocumentApiError(404, 'DOCUMENT_ARCHIVED', 'Document is archived.');
    const otherDoc = await CarrierDocument.findOne({ _id: documentId });
    if (otherDoc) throw new DocumentApiError(403, 'FORBIDDEN_TENANT_ACCESS', 'Document does not belong to this carrier or company.');
    throw new DocumentApiError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
  }

  return { success: true, document: toPublicDocument(document, { includeAudit: true }) };
}

async function downloadDocument(req, carrierId, documentId) {
  assertCompanyContext(req);

  if (!mongoose.Types.ObjectId.isValid(String(carrierId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Carrier ID must be a valid ObjectId.');
  }
  if (!mongoose.Types.ObjectId.isValid(String(documentId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Document ID must be a valid ObjectId.');
  }

  const carrier = await findCarrierForTenant(req, carrierId);
  if (!carrier) throw new DocumentApiError(404, 'CARRIER_NOT_FOUND', 'Carrier not found.');

  const document = await findDocumentForTenant(req, documentId);
  if (!document || !document.storageKey) {
    throw new DocumentApiError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
  }

  let fileBuffer;
  try {
    const result = await getFile(document.storageKey);
    fileBuffer = result.buffer;
  } catch (err) {
    if (err instanceof StorageError && err.code === 'FILE_NOT_FOUND') {
      throw new DocumentApiError(404, 'FILE_NOT_FOUND', 'Document file not found in storage.');
    }
    throw err;
  }

  return {
    buffer: fileBuffer,
    originalFilename: document.originalFilename,
    mimeType: document.mimeType,
    fileSize: document.fileSize
  };
}

async function uploadDocument(req, carrierId, fileBuffer, originalFilename, mimeType) {
  assertCompanyRole(req, 'CREATE');

  if (!mongoose.Types.ObjectId.isValid(String(carrierId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Carrier ID must be a valid ObjectId.');
  }

  const carrier = await findCarrierForTenant(req, carrierId);
  if (!carrier) throw new DocumentApiError(404, 'CARRIER_NOT_FOUND', 'Carrier not found.');

  const storageResult = await uploadFile(fileBuffer, originalFilename, mimeType);

  const latestVersion = await CarrierDocument.findOne({
    carrier: carrierId,
    ...carrierDocumentScope(req)
  }).sort({ version: -1 });

  const newVersion = latestVersion ? latestVersion.version + 1 : 1;

  const document = new CarrierDocument({
    carrier: carrierId,
    company: req.companyId,
    documentType: req.body.documentType,
    customDocumentType: req.body.customDocumentType,
    originalFilename: storageResult.originalFilename,
    storageKey: storageResult.storageKey,
    mimeType: storageResult.mimeType,
    fileSize: storageResult.fileSize,
    uploadedBy: req.user.id,
    uploadedAt: new Date(),
    verificationStatus: 'PENDING',
    version: newVersion,
    isDemoData: req.isDemoMode || false,
    auditLog: [{
      action: 'UPLOADED',
      actor: req.user.id,
      changedFields: ['documentType', 'originalFilename', 'storageKey', 'mimeType', 'fileSize'],
      occurredAt: new Date()
    }]
  });

  await document.save();

  return { success: true, document: toPublicDocument(document) };
}

async function updateDocumentMetadata(req, carrierId, documentId, updates) {
  assertCompanyRole(req, 'UPDATE');

  if (!mongoose.Types.ObjectId.isValid(String(carrierId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Carrier ID must be a valid ObjectId.');
  }
  if (!mongoose.Types.ObjectId.isValid(String(documentId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Document ID must be a valid ObjectId.');
  }

  const carrier = await findCarrierForTenant(req, carrierId);
  if (!carrier) throw new DocumentApiError(404, 'CARRIER_NOT_FOUND', 'Carrier not found.');

  const document = await findDocumentForTenant(req, documentId);
  if (!document) throw new DocumentApiError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');

  const changedFields = [];
  const payload = {};

  if (updates.documentType !== undefined) {
    validateDocumentType(updates.documentType, updates.customDocumentType);
    if (document.documentType !== updates.documentType) changedFields.push('documentType');
    payload.documentType = updates.documentType;
  }

  if (updates.customDocumentType !== undefined) {
    if (document.customDocumentType !== updates.customDocumentType) changedFields.push('customDocumentType');
    payload.customDocumentType = updates.customDocumentType;
  }

  if (updates.expirationDate !== undefined) {
    const expDate = new Date(updates.expirationDate);
    if (isNaN(expDate.getTime())) {
      throw new DocumentApiError(400, 'INVALID_FIELD', 'Invalid expirationDate.');
    }
    if (!document.expirationDate || document.expirationDate.getTime() !== expDate.getTime()) {
      changedFields.push('expirationDate');
    }
    payload.expirationDate = expDate;
  }

  if (changedFields.length === 0) {
    return { success: true, document: toPublicDocument(document) };
  }

  Object.assign(document, payload);
  document.updatedBy = req.user.id;
  document.addAuditEntry('UPDATED', req.user.id, changedFields);
  await document.save();

  return { success: true, document: toPublicDocument(document, { includeAudit: true }) };
}

async function verifyDocument(req, carrierId, documentId, status, notes) {
  assertDocumentRole(req, 'verify');

  if (!mongoose.Types.ObjectId.isValid(String(carrierId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Carrier ID must be a valid ObjectId.');
  }
  if (!mongoose.Types.ObjectId.isValid(String(documentId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Document ID must be a valid ObjectId.');
  }

  const carrier = await findCarrierForTenant(req, carrierId);
  if (!carrier) throw new DocumentApiError(404, 'CARRIER_NOT_FOUND', 'Carrier not found.');

  const document = await findDocumentForTenant(req, documentId);
  if (!document) throw new DocumentApiError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');

  if (document.verificationStatus === status) {
    throw new DocumentApiError(400, 'NO_CHANGE', `Document already has verification status ${status}.`);
  }

  document.verificationStatus = status;
  document.verifiedBy = req.user.id;
  document.verifiedAt = new Date();
  if (status === 'REJECTED' && notes) {
    document.rejectionReason = notes.substring(0, 1000);
  } else if (status !== 'REJECTED') {
    document.rejectionReason = undefined;
  }

  const changedFields = ['verificationStatus', 'verifiedBy', 'verifiedAt'];
  if (notes && status === 'REJECTED') changedFields.push('rejectionReason');

  document.addAuditEntry(status === 'VERIFIED' ? 'VERIFIED' : 'REJECTED', req.user.id, changedFields, notes);
  await document.save();

  return { success: true, document: toPublicDocument(document, { includeAudit: true }) };
}

async function archiveDocument(req, carrierId, documentId, reason) {
  assertDocumentRole(req, 'archive');

  if (!mongoose.Types.ObjectId.isValid(String(carrierId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Carrier ID must be a valid ObjectId.');
  }
  if (!mongoose.Types.ObjectId.isValid(String(documentId))) {
    throw new DocumentApiError(400, 'INVALID_ID', 'Document ID must be a valid ObjectId.');
  }

  const carrier = await findCarrierForTenant(req, carrierId);
  if (!carrier) throw new DocumentApiError(404, 'CARRIER_NOT_FOUND', 'Carrier not found.');

  const document = await findDocumentForTenant(req, documentId, { includeArchived: true });
  if (!document) throw new DocumentApiError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
  if (document.isArchived) throw new DocumentApiError(400, 'ALREADY_ARCHIVED', 'Document is already archived.');

  document.isArchived = true;
  document.archivedAt = new Date();
  document.archivedBy = req.user.id;
  document.addAuditEntry('ARCHIVED', req.user.id, ['isArchived'], reason);
  await document.save();

  return { success: true, document: toPublicDocument(document) };
}

function findCarrierForTenant(req, carrierId, { includeDemo = false } = {}) {
  const filter = { _id: carrierId, ...(includeDemo ? {} : { isDemoData: false }) };
  if (!req.isDemoMode) filter.company = req.companyId;
  return Carrier.findOne(filter);
}

function findDocumentForTenant(req, documentId, { includeArchived = false, includeDemo = false } = {}) {
  const filter = { _id: documentId };
  if (!req.isDemoMode) filter.company = req.companyId;
  if (!includeArchived) filter.isArchived = false;
  if (!includeDemo) filter.isDemoData = false;
  return CarrierDocument.findOne(filter);
}

module.exports = {
  DocumentApiError,
  mapDocumentError,
  listDocuments,
  getDocumentMetadata,
  downloadDocument,
  uploadDocument,
  updateDocumentMetadata,
  verifyDocument,
  archiveDocument,
  toPublicDocument
};
