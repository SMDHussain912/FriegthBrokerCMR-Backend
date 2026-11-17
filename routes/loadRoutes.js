const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const loadService = require('../services/loadService');
const { LoadApiError } = require('../services/loadService');
const { CarrierApiError } = require('../services/carrierService');
const { recordAuditEvent } = require('../services/auditService');

const handleError = (error, res, next) => {
  if (error instanceof LoadApiError) {
    return res.status(error.status).json({ success: false, error: error.message, code: error.code });
  }
  if (error instanceof CarrierApiError) {
    return res.status(error.status).json({ success: false, error: error.message, code: error.code });
  }
  if (error && (error.code === 'UNAUTHORIZED_OVERRIDE')) {
    return res.status(403).json({ success: false, error: error.message, code: error.code });
  }
  if (error && (error.code === 'OVERRIDE_REASON_REQUIRED' || error.code === 'OVERRIDE_AUTHORIZER_REQUIRED' || error.code === 'OVERRIDE_NOT_APPLICABLE' || error.code === 'INVALID_OVERRIDE_REASON' || error.code === 'OVERRIDE_REASON_TOO_SHORT')) {
    return res.status(400).json({ success: false, error: error.message, code: error.code });
  }
  if (error && (error.code === 'LOAD_CONFLICT' || error.code === 'ASSIGNMENT_CONFLICT' || error.code === 'LOAD_NOT_ASSIGNABLE' || error.code === 'LOAD_NOT_EDITABLE' || error.code === 'LOAD_NOT_DELETABLE')) {
    return res.status(409).json({ success: false, error: error.message, code: error.code });
  }
  if (error && error.name === 'ValidationError') {
    return res.status(400).json({ success: false, error: error.message, code: 'VALIDATION_ERROR' });
  }
  if (error && error.code === 11000) {
    return res.status(409).json({ success: false, error: 'A load with this identifier already exists in this context.', code: 'DUPLICATE_LOAD' });
  }
  return next(error);
};

router.get('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const result = await loadService.listLoads(req, req.query);
    return res.json(result);
  } catch (error) {
    return handleError(error, res, next);
  }
});

router.post('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const result = await loadService.createLoad(req, req.body || {});
    const load = result && (result.load || result);
    await recordAuditEvent({
      companyId: req.companyId || null,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'LOAD_CREATED',
      entityType: 'Load',
      entityId: load && (load._id || load.id),
      summary: 'Load created',
      metadata: { loadNumber: load && load.loadNumber, status: load && load.status },
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.status(201).json(result);
  } catch (error) {
    return handleError(error, res, next);
  }
});

router.get('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const result = await loadService.getLoad(req, req.params.id);
    return res.json(result);
  } catch (error) {
    return handleError(error, res, next);
  }
});

router.patch('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const result = await loadService.updateLoad(req, req.params.id, req.body || {});
    await recordAuditEvent({
      companyId: req.companyId || null,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'LOAD_UPDATED',
      entityType: 'Load',
      entityId: req.params.id,
      summary: 'Load updated',
      metadata: { fields: req.body && typeof req.body === 'object' ? Object.keys(req.body).slice(0, 20) : [] },
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.json(result);
  } catch (error) {
    return handleError(error, res, next);
  }
});

router.delete('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const result = await loadService.deleteLoad(req, req.params.id);
    await recordAuditEvent({
      companyId: req.companyId || null,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'LOAD_DELETED',
      entityType: 'Load',
      entityId: req.params.id,
      summary: 'Load deleted',
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.json(result);
  } catch (error) {
    return handleError(error, res, next);
  }
});

router.get('/:loadId/eligibility/:carrierId', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const result = await loadService.evaluateEligibility(req, req.params.loadId, req.params.carrierId);
    return res.json(result);
  } catch (error) {
    return handleError(error, res, next);
  }
});

router.post('/:id/assign', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const result = await loadService.assignLoad(req, req.params.id, req.body || {});
    const evaluation = result.evaluation;
    const decision = result.decision;
    const snapshot = result.snapshot;

    if (decision.assignmentDecision === 'REJECTED') {
      await recordAuditEvent({
        companyId: req.companyId || null,
        actorId: req.user && req.user.id,
        actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
        action: 'LOAD_ASSIGNMENT_REJECTED',
        entityType: 'Load',
        entityId: req.params.id,
        summary: 'Load assignment rejected by vetting/eligibility',
        metadata: { carrierId: req.body && req.body.carrierId, overallStatus: evaluation && evaluation.overallStatus, snapshotId: snapshot && String(snapshot._id) },
        isDemoData: Boolean(req.isDemoMode)
      });
      return res.status(400).json({
        success: false,
        error: 'Cannot assign carrier: carrier failed load-specific eligibility (' + evaluation.overallStatus + ')',
        overallStatus: evaluation.overallStatus,
        ruleVersion: evaluation.ruleVersion,
        auditSnapshotId: snapshot._id,
        failedChecks: decision.failedChecks,
        evaluation
      });
    }

    await recordAuditEvent({
      companyId: req.companyId || null,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'LOAD_ASSIGNED',
      entityType: 'Load',
      entityId: req.params.id,
      summary: 'Load assigned to carrier',
      metadata: { carrierId: snapshot && String(snapshot.carrierId), overallStatus: snapshot && snapshot.overallStatus, assignmentDecision: snapshot && snapshot.assignmentDecision, snapshotId: snapshot && String(snapshot._id) },
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.status(200).json({
      success: true,
      message: 'Carrier successfully assigned with due diligence snapshot generated',
      assignment: {
        id: snapshot._id,
        loadId: snapshot.loadId,
        loadNumber: snapshot.loadNumber,
        carrierId: snapshot.carrierId,
        carrierName: snapshot.carrierName,
        assignedBy: snapshot.assignedBy,
        actorRole: snapshot.actorRole,
        assignedAt: snapshot.assignedAt,
        ruleVersion: snapshot.ruleVersion,
        overallStatus: snapshot.overallStatus,
        assignmentDecision: snapshot.assignmentDecision,
        overrideDetails: snapshot.overrideDetails,
        dueDiligenceCertificateId: 'CERT-' + snapshot.loadNumber + '-' + (result.evaluation.carrierId || ''),
        evaluatedChecks: snapshot.evaluatedChecks
      },
      evaluation
    });
  } catch (error) {
    return handleError(error, res, next);
  }
});

router.get('/:id/assignment', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const result = await loadService.getLoadAssignment(req, req.params.id);
    return res.json(result);
  } catch (error) {
    return handleError(error, res, next);
  }
});

module.exports = router;
