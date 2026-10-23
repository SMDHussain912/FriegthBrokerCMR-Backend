const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Load = require('../models/Load');
const Carrier = require('../models/Carrier');
const CarrierAssignment = require('../models/CarrierAssignment');
const { evaluateCarrierForLoad } = require('../services/vettingEngine');
const { assignCarrierToLoad } = require('../services/assignmentService');
const { requireAuth } = require('../middleware/auth');

// Validate a MongoDB ObjectId path/body value
const assertObjectId = (value, label, res) => {
  if (!value || !mongoose.Types.ObjectId.isValid(String(value))) {
    res.status(400).json({
      success: false,
      error: label + ' must be a valid ObjectId',
      code: 'INVALID_ID'
    });
    return false;
  }
  return true;
};

/**
 * @route   GET /api/loads
 * @desc    Get all loads
 * @access  Authenticated (load data contains customer shipment details)
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { status, equipmentType } = req.query;
    const filter = {};

    if (status) {
      filter.status = status.toUpperCase();
    }
    if (equipmentType) {
      filter.equipmentType = equipmentType.toUpperCase();
    }

    const loads = await Load.find(filter)
      .populate('assignedCarrier', 'legalName dotNumber mcNumber')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: loads.length,
      loads
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/loads
 * @desc    Create a new load (authenticated; verification thresholds validated)
 * @access  Authenticated (any role)
 */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    // H3: never allow client to pre-claim assignment linkage fields.
    const sanitized = Object.assign({}, body);
    delete sanitized.status;
    delete sanitized.assignedCarrier;
    delete sanitized.assignedAt;
    delete sanitized.assignedBy;
    delete sanitized.auditSnapshotId;
    const load = await Load.create(sanitized);
    res.status(201).json({
      success: true,
      load
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/loads/:id
 * @desc    Get single load details
 * @access  Authenticated (load data contains customer shipment details)
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const load = await Load.findById(req.params.id)
      .populate('assignedCarrier', 'legalName dotNumber mcNumber overallStatus authorityStatus');

    if (!load) {
      return res.status(404).json({
        success: false,
        error: `Load not found with ID: ${req.params.id}`
      });
    }

    res.json({
      success: true,
      load
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/loads/:loadId/eligibility/:carrierId
 * @desc    Evaluate a carrier's load-specific eligibility against a specific load
 * @access  Public (in demo mode)
 */
router.get('/:loadId/eligibility/:carrierId', async (req, res, next) => {
  try {
    const { loadId, carrierId } = req.params;

    const [load, carrier] = await Promise.all([
      Load.findById(loadId),
      Carrier.findById(carrierId)
    ]);

    if (!load) {
      return res.status(404).json({
        success: false,
        error: `Load not found with ID: ${loadId}`
      });
    }

    if (!carrier) {
      return res.status(404).json({
        success: false,
        error: `Carrier not found with ID: ${carrierId}`
      });
    }

    const evaluation = evaluateCarrierForLoad(carrier, load);

    res.json({
      success: true,
      load: {
        id: load._id,
        loadNumber: load.loadNumber,
        commodity: load.commodity,
        equipmentType: load.equipmentType,
        declaredCargoValue: load.declaredCargoValue,
        targetTemperature: load.targetTemperature
      },
      carrier: {
        id: carrier._id,
        legalName: carrier.legalName,
        dotNumber: carrier.dotNumber,
        mcNumber: carrier.mcNumber
      },
      evaluation
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/loads/:id/assign
 * @desc    Evaluate carrier eligibility and assign carrier with versioned audit snapshot
 * @access  Authenticated. Identity + role derived from JWT (never req.body roles).
 * @body    { carrierId, overrideReason, allowOverride }
 */
router.post('/:id/assign', requireAuth, async (req, res, next) => {
  try {
    const loadId = req.params.id;
    const carrierId = req.body.carrierId;
    // C1 fix: identity and role come ONLY from verified JWT.
    const assignedBy = req.user.email;
    const actorRole = req.user.role;
    const overrideReason = req.body.overrideReason;
    const allowOverride = req.body.allowOverride;

    if (!assertObjectId(loadId, 'Load ID', res)) { return; }
    if (!assertObjectId(carrierId, 'carrierId', res)) { return; }
    if (req.body.overrideReason !== undefined && typeof req.body.overrideReason !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'overrideReason must be a string',
        code: 'INVALID_OVERRIDE_REASON'
      });
    }
    if (overrideReason !== undefined && overrideReason !== null) {
      const trimmed = String(overrideReason).trim();
      if (trimmed.length > 0 && trimmed.length < 10) {
        return res.status(400).json({
          success: false,
          error: 'overrideReason must be at least 10 characters when provided',
          code: 'OVERRIDE_REASON_TOO_SHORT'
        });
      }
    }

    const load = await Load.findById(loadId);
    if (!load) {
      return res.status(404).json({
        success: false,
        error: 'Load not found with ID: ' + loadId
      });
    }

    const carrier = await Carrier.findById(carrierId);
    if (!carrier) {
      return res.status(404).json({
        success: false,
        error: 'Carrier not found with ID: ' + carrierId
      });
    }

    if (load.status && load.status !== 'POSTED') {
      return res.status(409).json({
        success: false,
        error: 'Load ' + load.loadNumber + ' is already ' + load.status + ' and cannot be reassigned via this endpoint'
      });
    }

    let result;
    try {
      result = await assignCarrierToLoad({
        load,
        carrier,
        actor: { assignedBy: assignedBy, actorRole: actorRole },
        override: { overrideReason: overrideReason, allowOverride: allowOverride }
      });
    } catch (assignError) {
      if (assignError.code === 'UNAUTHORIZED_OVERRIDE') {
        return res.status(403).json({
          success: false,
          error: assignError.message,
          code: assignError.code
        });
      }
      if (assignError.code === 'OVERRIDE_REASON_REQUIRED' || assignError.code === 'OVERRIDE_AUTHORIZER_REQUIRED') {
        return res.status(400).json({
          success: false,
          error: assignError.message,
          code: assignError.code
        });
      }
      if (assignError.code === 'OVERRIDE_NOT_APPLICABLE') {
        return res.status(400).json({
          success: false,
          error: assignError.message,
          code: assignError.code
        });
      }
      if (assignError.code === 'LOAD_CONFLICT' || assignError.code === 'ASSIGNMENT_CONFLICT') {
        return res.status(409).json({
          success: false,
          error: assignError.message,
          code: assignError.code
        });
      }
      throw assignError;
    }

    const evaluation = result.evaluation;
    const decision = result.decision;
    const snapshot = result.snapshot;

    if (decision.assignmentDecision === 'REJECTED') {
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

    return res.status(200).json({
      success: true,
      message: 'Carrier successfully assigned with due diligence snapshot generated (DEMO data only)',
      assignment: {
        id: snapshot._id,
        loadId: load._id,
        loadNumber: load.loadNumber,
        carrierId: carrier._id,
        carrierName: carrier.legalName,
        assignedBy: snapshot.assignedBy,
        actorRole: snapshot.actorRole,
        assignedAt: snapshot.assignedAt,
        ruleVersion: snapshot.ruleVersion,
        overallStatus: snapshot.overallStatus,
        assignmentDecision: snapshot.assignmentDecision,
        overrideDetails: snapshot.overrideDetails,
        dueDiligenceCertificateId: 'CERT-' + load.loadNumber + '-' + carrier.dotNumber,
        evaluatedChecks: snapshot.evaluatedChecks
      },
      evaluation
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/loads/:id/assignment
 * @desc    Fetch the ACTIVE audit snapshot for a load (H2: never newest-attempt fallback)
 * @access  Authenticated
 */
router.get('/:id/assignment', requireAuth, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.id, 'Load ID', res)) { return; }
    const load = await Load.findById(req.params.id)
      .populate('assignedCarrier', 'legalName dotNumber mcNumber overallStatus authorityStatus');
    if (!load) {
      return res.status(404).json({
        success: false,
        error: 'Load not found with ID: ' + req.params.id
      });
    }
    // H2: the ACTIVE snapshot is the one the load points to. No latest-fallback.
    if (!load.auditSnapshotId) {
      const rejectedAttempts = await CarrierAssignment.countDocuments({
        loadId: load._id,
        assignmentDecision: 'REJECTED'
      });
      return res.status(404).json({
        success: false,
        error: 'No active assignment for load ' + load.loadNumber,
        code: 'NO_ACTIVE_ASSIGNMENT',
        loadStatus: load.status,
        rejectedAttempts
      });
    }
    const snapshot = await CarrierAssignment.findById(load.auditSnapshotId);
    if (!snapshot) {
      return res.status(500).json({
        success: false,
        error: 'Load references a missing audit snapshot (data integrity failure)',
        code: 'SNAPSHOT_REFERENCE_BROKEN',
        auditSnapshotId: load.auditSnapshotId
      });
    }
    const rejectedAttempts = await CarrierAssignment.countDocuments({
      loadId: load._id,
      assignmentDecision: 'REJECTED'
    });
    res.json({
      success: true,
      loadNumber: load.loadNumber,
      loadStatus: load.status,
      rejectedAttempts,
      snapshot
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
