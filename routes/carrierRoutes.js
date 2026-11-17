const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const { evaluateCarrier, VettingApiError } = require('../services/vettingService');
const { recordAuditEvent } = require('../services/auditService');
const {
  CarrierApiError,
  mapCarrierError,
  getCarrierCapabilities,
  listCarriers,
  createCarrier,
  findCarrierForTenant,
  updateCarrier,
  archiveCarrier,
  toPublicCarrier
} = require('../services/carrierService');

const handleCarrierError = (error, res, next) => {
  if (error instanceof VettingApiError) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
      code: error.code
    });
  }
  const mappedError = mapCarrierError(error);
  if (mappedError instanceof CarrierApiError) {
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

/**
 * @route   GET /api/carriers
 * @desc    Search and list carriers.
 *          - If authenticated with company context: returns only active company production carriers.
 *          - In explicit demo mode (?demo=true or x-demo-mode: true): returns ONLY demo carriers.
 *          - Production carrier data is NEVER exposed without authenticated company membership.
 * @access  Authenticated (requires active company membership or explicit demo mode)
 */
router.get('/', optionalAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const result = await listCarriers(req, req.query);
    res.json(result);
  } catch (error) {
    handleCarrierError(error, res, next);
  }
});

router.post('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const carrier = await createCarrier(req, req.body);
    await recordAuditEvent({
      companyId: req.companyId || null,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'CARRIER_CREATED',
      entityType: 'Carrier',
      entityId: carrier && (carrier._id || carrier.id),
      summary: 'Carrier created',
      metadata: { legalName: carrier && carrier.legalName, dotNumber: carrier && carrier.dotNumber },
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.status(201).json({ success: true, carrier });
  } catch (error) {
    return handleCarrierError(error, res, next);
  }
});

router.get('/context', requireAuth, requireCompanyContext, (req, res) => {
  return res.json({
    success: true,
    demoMode: Boolean(req.isDemoMode),
    capabilities: getCarrierCapabilities(req)
  });
});

/**
 * @route   GET /api/carriers/:id
 * @desc    Get detailed carrier dossier (scoped to active company or demo)
 * @access  Authenticated (requires active company membership or explicit demo mode)
 */
router.get('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }

    const carrier = await findCarrierForTenant(req, req.params.id);

    res.json({
      success: true,
      carrier: toPublicCarrier(carrier)
    });
  } catch (error) {
    handleCarrierError(error, res, next);
  }
});

/**
 * @route   GET /api/carriers/:id/vet
 * @desc    Run company-scoped baseline vetting evaluation on a carrier
 * @access  Authenticated (requires verified active company membership; demo mode denied)
 */
router.get('/:id/vet', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const result = await evaluateCarrier(req, req.params.id);
    return res.json({
      success: true,
      evaluation: result.evaluation
    });
  } catch (error) {
    return handleCarrierError(error, res, next);
  }
});

/**
 * H3: verification metadata is server-authoritative. Only compliance/admin
 * can mark a policy VERIFIED/REJECTED, and verifiedBy/verifiedAt are stamped
 * from the JWT identity — never from the request body.
 *
 * @route   PATCH /api/carriers/:carrierId/policies/:policyId/verify
 * @access  compliance_officer, admin (scoped to active company or demo)
 */
router.patch(
  '/:carrierId/policies/:policyId/verify',
  requireAuth,
  requireCompanyContext,
  async (req, res, next) => {
    try {
      if (!assertObjectId(req.params.carrierId, 'Carrier ID', res)) { return; }
      if (!assertObjectId(req.params.policyId, 'Policy ID', res)) { return; }
      const status = req.body.status ? String(req.body.status).toUpperCase() : '';
      if (['VERIFIED', 'REJECTED', 'EXPIRED'].indexOf(status) === -1) {
        return res.status(400).json({
          success: false,
          error: 'status must be one of VERIFIED, REJECTED, EXPIRED',
          code: 'INVALID_VERIFY_STATUS'
        });
      }
      const notes = req.body.verificationNotes !== undefined ? String(req.body.verificationNotes) : '';
      if (notes.length > 2000) {
        return res.status(400).json({
          success: false,
          error: 'verificationNotes must be 2000 characters or fewer',
          code: 'NOTES_TOO_LONG'
        });
      }

      const globalRoles = ['compliance_officer', 'admin'];
      const membershipRoles = ['compliance_officer', 'admin', 'broker_owner', 'broker_admin'];
      const authorized = req.isDemoMode
        ? (req.user && globalRoles.includes(req.user.role))
        : (req.membership && membershipRoles.includes(req.membership.role));
      if (!authorized) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to verify carrier policy documents',
          code: 'FORBIDDEN_ROLE'
        });
      }

      const carrier = await findCarrierForTenant(req, req.params.carrierId, { includeAudit: true });

      const policy = carrier.insurancePolicies.id(req.params.policyId);
      if (!policy) {
        return res.status(404).json({ success: false, error: 'Policy not found' });
      }
      policy.verificationStatus = status;
      policy.verifiedBy = req.user.email;
      policy.verifiedAt = new Date();
      policy.verificationNotes = notes;
      carrier.auditLog = [...(carrier.auditLog || []), {
        action: 'UPDATED',
        actor: req.user.id,
        changedFields: ['insurancePolicies.verificationStatus'],
        occurredAt: new Date()
      }].slice(-100);
      await carrier.save();
      const policyResult = policy.toObject();
      delete policyResult.uploadedDocumentUri;
      await recordAuditEvent({
        companyId: req.companyId || null,
        actorId: req.user && req.user.id,
        actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
        action: 'CARRIER_POLICY_VERIFIED',
        entityType: 'CarrierPolicy',
        entityId: req.params.policyId,
        summary: 'Carrier insurance policy verification updated',
        metadata: { carrierId: String(req.params.carrierId), status },
        isDemoData: Boolean(req.isDemoMode)
      });
      res.json({ success: true, policy: policyResult });
    } catch (error) {
      handleCarrierError(error, res, next);
    }
  }
);

/** @route PATCH /api/carriers/:id */
router.patch('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    const carrier = await updateCarrier(req, req.params.id, req.body);
    await recordAuditEvent({
      companyId: req.companyId || null,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'CARRIER_UPDATED',
      entityType: 'Carrier',
      entityId: req.params.id,
      summary: 'Carrier updated',
      metadata: { fields: req.body && typeof req.body === 'object' ? Object.keys(req.body).slice(0, 20) : [] },
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.json({ success: true, carrier });
  } catch (error) {
    return handleCarrierError(error, res, next);
  }
});

/** @route PATCH /api/carriers/:id/archive */
router.patch('/:id/archive', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    const carrier = await archiveCarrier(req, req.params.id, req.body);
    await recordAuditEvent({
      companyId: req.companyId || null,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'CARRIER_ARCHIVED',
      entityType: 'Carrier',
      entityId: req.params.id,
      summary: 'Carrier archived',
      metadata: { reason: req.body && req.body.reason ? String(req.body.reason).slice(0, 200) : undefined },
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.json({ success: true, carrier });
  } catch (error) {
    return handleCarrierError(error, res, next);
  }
});
module.exports = router;
