const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const expiry = require('../services/documentExpiryService');
const { DocumentExpiryError } = require('../services/documentExpiryService');

function handle(err, res, next) {
  if (err instanceof DocumentExpiryError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return next(err);
}

// Scan for expiring documents
router.get('/expiring', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await expiry.scanExpiringDocuments(req, req.query)); } catch (e) { handle(e, res, next); }
});

// Record expiry audit events for all expiring/expired documents
router.post('/record-audit', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await expiry.recordExpiryAudit(req, req.query)); } catch (e) { handle(e, res, next); }
});

module.exports = router;
