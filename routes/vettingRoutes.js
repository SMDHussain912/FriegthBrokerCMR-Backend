const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const {
  VettingApiError,
  toPublicConfig,
  getOrCreateCompanyConfig,
  updateCompanyConfig,
  getConfigAudit
} = require('../services/vettingService');
const { CarrierApiError } = require('../services/carrierService');
const { recordAuditEvent } = require('../services/auditService');

const handleVettingError = (error, res, next) => {
  if (error instanceof VettingApiError) {
    return res.status(error.status).json({ success: false, error: error.message, code: error.code });
  }
  if (error instanceof CarrierApiError) {
    return res.status(error.status).json({ success: false, error: error.message, code: error.code });
  }
  return next(error);
};

router.get('/configuration', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const config = await getOrCreateCompanyConfig(req, { createIfMissing: false });
    return res.json({ success: true, configuration: toPublicConfig(config) });
  } catch (error) {
    return handleVettingError(error, res, next);
  }
});

router.put('/configuration', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const config = await updateCompanyConfig(req, req.body || {});
    await recordAuditEvent({
      companyId: req.companyId || null,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'VETTING_CONFIGURATION_UPDATED',
      entityType: 'VettingConfiguration',
      entityId: config && (config._id || config.id),
      summary: 'Vetting configuration updated',
      metadata: { fields: req.body && typeof req.body === 'object' ? Object.keys(req.body).slice(0, 20) : [] },
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.json({ success: true, configuration: toPublicConfig(config) });
  } catch (error) {
    return handleVettingError(error, res, next);
  }
});

router.get('/configuration/audit', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const auditLog = await getConfigAudit(req);
    return res.json({ success: true, auditLog });
  } catch (error) {
    return handleVettingError(error, res, next);
  }
});

module.exports = router;
