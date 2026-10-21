const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Carrier = require('../models/Carrier');
const { evaluateCarrierForLoad } = require('../services/vettingEngine');
const { requireAuth, requireRole } = require('../middleware/auth');

const assertObjectId = (value, label, res) => {
  if (!value || !mongoose.Types.ObjectId.isValid(String(value))) {
    res.status(400).json({ success: false, error: label + ' must be a valid ObjectId', code: 'INVALID_ID' });
    return false;
  }
  return true;
};

/**
 * @route   GET /api/carriers
 * @desc    Search and list carriers
 * @access  Public (in demo mode)
 */
router.get('/', async (req, res, next) => {
  try {
    const { query, status } = req.query;
    const filter = {};

    if (query) {
      filter.$or = [
        { legalName: { $regex: query, $options: 'i' } },
        { dbaName: { $regex: query, $options: 'i' } },
        { dotNumber: { $regex: query, $options: 'i' } },
        { mcNumber: { $regex: query, $options: 'i' } }
      ];
    }

    if (status) {
      filter.overallStatus = status.toUpperCase();
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
 * @route   GET /api/carriers/:id
 * @desc    Get detailed carrier dossier
 * @access  Authenticated
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    const carrier = await Carrier.findById(req.params.id);
    if (!carrier) {
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
 * @desc    Run global account-level vetting evaluation on a carrier
 * @access  Authenticated
 */
router.get('/:id/vet', requireAuth, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Carrier ID', res)) { return; }
    const carrier = await Carrier.findById(req.params.id);
    if (!carrier) {
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
 * @access  compliance_officer, admin
 */
router.patch(
  '/:carrierId/policies/:policyId/verify',
  requireAuth,
  requireRole('compliance_officer', 'admin'),
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
      const carrier = await Carrier.findById(req.params.carrierId);
      if (!carrier) {
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
