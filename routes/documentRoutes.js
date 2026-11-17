const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const { recordAuditEvent } = require('../services/auditService');
const {
  DocumentApiError,
  mapDocumentError,
  listDocuments,
  getDocumentMetadata,
  downloadDocument,
  uploadDocument,
  updateDocumentMetadata,
  verifyDocument,
  archiveDocument
} = require('../services/documentService');

const handleDocumentError = (error, res, next) => {
  const mappedError = mapDocumentError(error);
  if (mappedError instanceof DocumentApiError) {
    return res.status(mappedError.status).json({
      success: false,
      error: mappedError.message,
      code: mappedError.code
    });
  }
  return next(mappedError);
};

const assertObjectId = (value, label, res) => {
  if (!value || !mongoose.Types.ObjectId.isValid(String(value))) {
    res.status(400).json({ success: false, error: label + ' must be a valid ObjectId', code: 'INVALID_ID' });
    return false;
  }
  return true;
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/tiff', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new DocumentApiError(400, 'INVALID_MIME_TYPE', `File type ${file.mimetype} is not allowed.`));
    }
  }
});

module.exports = router;

/**
 * @route   POST /api/carriers/:id/documents
 * @desc    Upload a document for a carrier
 * @access  Authenticated (company-scoped, create role)
 */
router.post('/:id/documents', requireAuth, requireCompanyContext, upload.single('file'), async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded.', code: 'NO_FILE' });
    }

    const result = await uploadDocument(req, req.params.id, req.file.buffer, req.file.originalname, req.file.mimetype);
    await recordAuditEvent({ companyId: req.companyId || null, actorId: req.user && req.user.id, actorRole: (req.membership && req.membership.role) || (req.user && req.user.role), action: 'DOCUMENT_UPLOADED', entityType: 'CarrierDocument', entityId: result && result.document && (result.document._id || result.document.id), summary: 'Carrier document uploaded', metadata: { carrierId: String(req.params.id), documentType: result && result.document && result.document.documentType }, isDemoData: Boolean(req.isDemoMode) });
    return res.status(201).json(result);
  } catch (error) {
    handleDocumentError(error, res, next);
  }
});

/**
 * @route   GET /api/carriers/:id/documents
 * @desc    List documents for a carrier
 * @access  Authenticated (company-scoped)
 */
router.get('/:id/documents', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    const result = await listDocuments(req, req.params.id, {
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
      documentType: req.query.documentType,
      verificationStatus: req.query.verificationStatus,
      isArchived: req.query.isArchived
    });
    return res.json(result);
  } catch (error) {
    handleDocumentError(error, res, next);
  }
});

/**
 * @route   GET /api/carriers/:id/documents/:documentId
 * @desc    Get document metadata
 * @access  Authenticated (company-scoped)
 */
router.get('/:id/documents/:documentId', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    if (!assertObjectId(req.params.documentId, 'Document ID', res)) { return; }
    const result = await getDocumentMetadata(req, req.params.id, req.params.documentId);
    return res.json(result);
  } catch (error) {
    handleDocumentError(error, res, next);
  }
});

/**
 * @route   GET /api/carriers/:id/documents/:documentId/download
 * @desc    Download a document file
 * @access  Authenticated (company-scoped)
 */
router.get('/:id/documents/:documentId/download', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    if (!assertObjectId(req.params.documentId, 'Document ID', res)) { return; }
    const result = await downloadDocument(req, req.params.id, req.params.documentId);
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.originalFilename)}"`);
    res.setHeader('Content-Length', result.fileSize);
    return res.send(result.buffer);
  } catch (error) {
    handleDocumentError(error, res, next);
  }
});

/**
 * @route   PATCH /api/carriers/:id/documents/:documentId
 * @desc    Update document metadata
 * @access  Authenticated (company-scoped, update role)
 */
router.patch('/:id/documents/:documentId', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    if (!assertObjectId(req.params.documentId, 'Document ID', res)) { return; }
    const result = await updateDocumentMetadata(req, req.params.id, req.params.documentId, req.body);
    await recordAuditEvent({ companyId: req.companyId || null, actorId: req.user && req.user.id, actorRole: (req.membership && req.membership.role) || (req.user && req.user.role), action: 'DOCUMENT_UPDATED', entityType: 'CarrierDocument', entityId: req.params.documentId, summary: 'Carrier document metadata updated', metadata: { carrierId: String(req.params.id), fields: req.body && typeof req.body === 'object' ? Object.keys(req.body).slice(0, 20) : [] }, isDemoData: Boolean(req.isDemoMode) });
    return res.json(result);
  } catch (error) {
    handleDocumentError(error, res, next);
  }
});

/**
 * @route   POST /api/carriers/:id/documents/:documentId/verify
 * @desc    Verify a document
 * @access  compliance_officer, admin (company-scoped)
 */
router.post('/:id/documents/:documentId/verify', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    if (!assertObjectId(req.params.documentId, 'Document ID', res)) { return; }
    const { status, notes } = req.body;
    const result = await verifyDocument(req, req.params.id, req.params.documentId, status, notes);
    await recordAuditEvent({ companyId: req.companyId || null, actorId: req.user && req.user.id, actorRole: (req.membership && req.membership.role) || (req.user && req.user.role), action: 'DOCUMENT_VERIFIED', entityType: 'CarrierDocument', entityId: req.params.documentId, summary: 'Carrier document verification status updated', metadata: { carrierId: String(req.params.id), status }, isDemoData: Boolean(req.isDemoMode) });
    return res.json(result);
  } catch (error) {
    handleDocumentError(error, res, next);
  }
});

/**
 * @route   POST /api/carriers/:id/documents/:documentId/reject
 * @desc    Reject a document
 * @access  compliance_officer, admin (company-scoped)
 */
router.post('/:id/documents/:documentId/reject', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    if (!assertObjectId(req.params.documentId, 'Document ID', res)) { return; }
    const { notes } = req.body;
    const result = await verifyDocument(req, req.params.id, req.params.documentId, 'REJECTED', notes);
    await recordAuditEvent({ companyId: req.companyId || null, actorId: req.user && req.user.id, actorRole: (req.membership && req.membership.role) || (req.user && req.user.role), action: 'DOCUMENT_REJECTED', entityType: 'CarrierDocument', entityId: req.params.documentId, summary: 'Carrier document rejected', metadata: { carrierId: String(req.params.id) }, isDemoData: Boolean(req.isDemoMode) });
    return res.json(result);
  } catch (error) {
    handleDocumentError(error, res, next);
  }
});

/**
 * @route   POST /api/carriers/:id/documents/:documentId/archive
 * @desc    Archive a document
 * @access  compliance_officer, admin (company-scoped)
 */
router.post('/:id/documents/:documentId/archive', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    if (!assertObjectId(req.params.documentId, 'Document ID', res)) { return; }
    const { reason } = req.body;
    const result = await archiveDocument(req, req.params.id, req.params.documentId, reason);
    await recordAuditEvent({ companyId: req.companyId || null, actorId: req.user && req.user.id, actorRole: (req.membership && req.membership.role) || (req.user && req.user.role), action: 'DOCUMENT_ARCHIVED', entityType: 'CarrierDocument', entityId: req.params.documentId, summary: 'Carrier document archived', metadata: { carrierId: String(req.params.id) }, isDemoData: Boolean(req.isDemoMode) });
    return res.json(result);
  } catch (error) {
    handleDocumentError(error, res, next);
  }
});

module.exports = router;