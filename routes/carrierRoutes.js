const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Carrier = require('../models/Carrier');
const { evaluateCarrierForLoad } = require('../services/vettingEngine');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');

const assertObjectId = (value, label, res) => {
  if (!value || !mongoose.Types.ObjectId.isValid(String(value))) {
    res.status(400).json({ success: false, error: label + ' must be a valid ObjectId', code: 'INVALID_ID' });
    return false;
  }
  return true;
};

/**
 * Escape regex special characters to prevent ReDoS.
 */
const escapeRegex = (string) => {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const { query, status } = req.query;
    const filter = {};

    if (req.isDemoMode) {
      filter.isDemoData = true;
    } else if (req.companyId && req.membership) {
      filter.company = req.companyId;
      filter.isDemoData = false;
    } else {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Verified company context required',
        code: 'COMPANY_CONTEXT_REQUIRED'
      });
    }

    if (query) {
      const sanitized = escapeRegex(query.trim());
      const queryFilter = [
        { legalName: { $regex: sanitized, $options: 'i' } },
        { dbaName: { $regex: sanitized, $options: 'i' } },
        { dotNumber: { $regex: sanitized, $options: 'i' } },
        { mcNumber: { $regex: sanitized, $options: 'i' } }
      ];

      filter.$or = queryFilter;
    }

    if (status) {
      filter.overallStatus = String(status).toUpperCase();
    }

    const carriers = await Carrier.find(filter).sort({ legalName: 1 });
    res.json({
      success: true,
      count: carriers.length,
      carriers
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Helper to find carrier scoped to company or demo
 */
async function findAuthorizedCarrier(carrierId, companyId, isDemoMode) {
  if (isDemoMode) {
    return Carrier.findOne({ _id: carrierId, isDemoData: true });
  }
  if (companyId) {
    return Carrier.findOne({
      _id: carrierId,
      company: companyId,
      isDemoData: false
    });
  }
  return null;
}

/**
 * @route   GET /api/carriers/:id
 * @desc    Get detailed carrier dossier (scoped to active company or demo)
 * @access  Authenticated (requires active company membership or explicit demo mode)
 */
router.get('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }

    const carrier = await findAuthorizedCarrier(req.params.id, req.companyId, req.isDemoMode);

    if (!carrier) {
      // Check if carrier exists in another company to return proper 403 vs 404
      const otherCarrier = await Carrier.findById(req.params.id);
      if (otherCarrier) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Carrier does not belong to the active company',
          code: 'FORBIDDEN_TENANT_ACCESS'
        });
      }
      return res.status(404).json({
        success: false,
        error: `Carrier not found with ID: ${req.params.id}`
      });
    }

    res.json({
      success: true,
      carrier
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/carriers/:id/vet
 * @desc    Run global account-level vetting evaluation on a carrier (scoped to company or demo)
 * @access  Authenticated (requires active company membership or explicit demo mode)
 */
router.get('/:id/vet', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }

    const carrier = await findAuthorizedCarrier(req.params.id, req.companyId, req.isDemoMode);

    if (!carrier) {
      const otherCarrier = await Carrier.findById(req.params.id);
      if (otherCarrier) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Carrier does not belong to the active company',
          code: 'FORBIDDEN_TENANT_ACCESS'
        });
      }
      return res.status(404).json({
        success: false,
        error: `Carrier not found with ID: ${req.params.id}`
      });
    }

    // Default global baseline criteria (dry van, $100k standard cargo, $1M auto)
    const baselineLoad = {
      loadNumber: 'BASELINE-EVALUATION',
      commodity: 'General Freight',
      equipmentType: 'DRY_VAN',
      declaredCargoValue: 100000,
      loadRequirements: {
        minAuthorityAgeDays: 90,
        minAutoLiability: 1000000,
        requireReeferEndorsement: false,
        disallowConditionalSafety: true
      }
    };

    const evaluation = evaluateCarrierForLoad(carrier, baselineLoad);

    res.json({
      success: true,
      evaluation
    });
  } catch (error) {
    next(error);
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
  requireRole('compliance_officer', 'admin'),
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

      const carrier = await findAuthorizedCarrier(
        req.params.carrierId,
        req.companyId,
        req.isDemoMode
      );

      if (!carrier) {
        const otherCarrier = await Carrier.findById(req.params.carrierId);
        if (otherCarrier) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden: Carrier does not belong to the active company',
            code: 'FORBIDDEN_TENANT_ACCESS'
          });
        }
        return res.status(404).json({ success: false, error: 'Carrier not found' });
      }

      const policy = carrier.insurancePolicies.id(req.params.policyId);
      if (!policy) {
        return res.status(404).json({ success: false, error: 'Policy not found' });
      }
      policy.verificationStatus = status;
      policy.verifiedBy = req.user.email;
      policy.verifiedAt = new Date();
      policy.verificationNotes = notes;
      await carrier.save();
      res.json({ success: true, policy });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
