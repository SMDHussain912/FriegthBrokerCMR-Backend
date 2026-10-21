/**
 * Carrier Assignment Service — remediated (C1/C2/H1/H2/H3)
 * DEMO data only. No live FMCSA or insurance verification.
 *
 * Trust model:
 * - Identity + role ALWAYS come from verified JWT (req.user), never req.body.
 * - allowedOverrideRoles checked server-side; authorizedBy = req.user identity.
 * - Concurrency: standalone MongoDB has no multi-doc transactions, so the
 *   load claim uses an atomic single-document conditional update
 *   (findOneAndUpdate filter status POSTED) plus a partial unique index
 *   (one APPROVED/OVERRIDDEN snapshot per load). Losers get HTTP 409.
 */

const CarrierAssignment = require('../models/CarrierAssignment');
const Load = require('../models/Load');
const { evaluateCarrierForLoad, RULE_VERSION } = require('./vettingEngine');

const PRIVILEGED_OVERRIDE_ROLES = ['compliance_officer', 'admin'];

const normalizeRole = (role) => (typeof role === 'string' ? role.trim().toLowerCase() : 'broker');

const buildSnapshotChecks = (evaluation, fallbackDate) => evaluation.checks.map((check) => ({
  ruleKey: check.ruleKey,
  ruleName: check.ruleName,
  status: check.status,
  reasonCode: check.reasonCode,
  requiredValue: check.requiredValue !== undefined ? check.requiredValue : null,
  actualValue: check.actualValue !== undefined ? check.actualValue : null,
  evidenceSource: (check.evidence && check.evidence.source) || 'Unknown Source (Demo)',
  evidenceTimestamp: (check.evidence && check.evidence.timestamp)
    ? new Date(check.evidence.timestamp)
    : new Date(fallbackDate),
  notes: check.notes || ''
}));

/**
 * Evaluate carrier eligibility and decide assignment outcome.
 * Pure function (no DB writes) — safe for unit testing.
 * actorRole must be the server-verified JWT role; authorizedBy the JWT identity.
 */
const decideAssignment = (evaluation, options = {}) => {
  const actorRole = options.actorRole || 'broker';
  const overrideReason = options.overrideReason;
  const authorizedBy = options.authorizedBy;
  const role = normalizeRole(actorRole);
  const overallStatus = evaluation.overallStatus;
  const wantsOverride = overrideReason !== undefined && overrideReason !== null
    ? String(overrideReason).trim().length > 0
    : false;

  if (overallStatus === 'PASS') {
    if (wantsOverride) {
      const err = new Error('Override is not applicable: carrier already PASS; no override needed');
      err.statusCode = 400;
      err.code = 'OVERRIDE_NOT_APPLICABLE';
      throw err;
    }
    return {
      allowed: true,
      assignmentDecision: 'APPROVED',
      overrideDetails: { overrideGranted: false }
    };
  }

  if (!wantsOverride) {
    return {
      allowed: false,
      assignmentDecision: 'REJECTED',
      blockReason: 'Carrier eligibility is ' + overallStatus + '. Assignment blocked under configured rules.',
      failedChecks: evaluation.checks.filter((c) => c.status !== 'PASS')
    };
  }

  if (PRIVILEGED_OVERRIDE_ROLES.indexOf(role) === -1) {
    const err = new Error('Unauthorized override: override requires compliance_officer or admin role');
    err.statusCode = 403;
    err.code = 'UNAUTHORIZED_OVERRIDE';
    throw err;
  }

  if (!overrideReason || String(overrideReason).trim().length < 10) {
    const err = new Error('Override requires a written reason of at least 10 characters (overrideReason)');
    err.statusCode = 400;
    err.code = 'OVERRIDE_REASON_REQUIRED';
    throw err;
  }

  // authorizedBy must equal the verified JWT identity (checked by caller);
  // the service stamps it, never accepting a different client-supplied name.
  if (!authorizedBy || String(authorizedBy).trim().length === 0) {
    const err = new Error('Override requires the verified authorizer identity');
    err.statusCode = 400;
    err.code = 'OVERRIDE_AUTHORIZER_REQUIRED';
    throw err;
  }

  return {
    allowed: true,
    assignmentDecision: 'OVERRIDDEN',
    overrideDetails: {
      overrideGranted: true,
      overrideReason: String(overrideReason).trim(),
      authorizedBy: String(authorizedBy).trim(),
      authorizedRole: role,
      authorizedAt: new Date()
    }
  };
};

/**
 * Persist consistently on standalone MongoDB (no multi-doc transactions):
 * 1. REJECTED: snapshot only (audit trail of blocked attempt), load untouched.
 * 2. APPROVED/OVERRIDDEN: atomic load claim FIRST via findOneAndUpdate
 *    filter { _id, status: POSTED } — exactly one concurrent winner.
 *    Then create the approval snapshot. If snapshot creation fails after a
 *    successful claim, the claim is released (status back to POSTED) so no
 *    assigned-without-audit load remains; caller gets 500 and may retry.
 *    A partial unique index (one APPROVED/OVERRIDDEN per load) is the final
 *    backstop: duplicate-key maps to HTTP 409 conflict.
 *
 * attemptNumber sequences audit attempts per load (H2).
 */
const persistAssignmentConsistently = async (params) => {
  const load = params.load;
  const carrier = params.carrier;
  const evaluation = params.evaluation;
  const actor = params.actor;
  const decision = params.decision;
  const LoadModel = params.loadModel || Load;
  const AssignedModel = params.assignmentModel || CarrierAssignment;
  const assignedAt = new Date();
  // H2: ruleVersion stamped ONLY from the evaluated result (no schema default).
  const ruleVersion = evaluation.ruleVersion;
  if (!ruleVersion) {
    const err = new Error('Evaluation ruleVersion missing; refusing to snapshot');
    err.statusCode = 500;
    err.code = 'RULE_VERSION_MISSING';
    throw err;
  }
  // H2: attempt numbering must be monotonic even when earlier snapshots were
  // rolled back/deleted (countDocuments would reuse numbers after a gap).
  const maxAttempt = await AssignedModel.aggregate([
    { $match: { loadId: load._id } },
    { $group: { _id: null, maxAttempt: { $max: '$attemptNumber' } } }
  ]);
  const attemptNumber = (maxAttempt[0] && maxAttempt[0].maxAttempt
    ? maxAttempt[0].maxAttempt
    : 0) + 1;
  const snapshotPayload = {
    loadId: load._id,
    loadNumber: load.loadNumber,
    carrierId: carrier._id,
    carrierName: carrier.legalName,
    assignedBy: actor.assignedBy,
    actorRole: actor.actorRole,
    assignedAt,
    attemptNumber,
    ruleVersion,
    overallStatus: evaluation.overallStatus,
    assignmentDecision: decision.assignmentDecision,
    overrideDetails: decision.overrideDetails || { overrideGranted: false },
    evaluatedChecks: buildSnapshotChecks(evaluation, assignedAt),
    isDemoData: true
  };

  if (decision.assignmentDecision === 'REJECTED') {
    const snapshot = await AssignedModel.create(snapshotPayload);
    return { snapshot, loadMutated: false };
  }

  // Atomic claim: only one concurrent request can flip POSTED -> ASSIGNED.
  const claimed = await LoadModel.findOneAndUpdate(
    { _id: load._id, status: 'POSTED' },
    {
      $set: {
        status: 'ASSIGNED',
        assignedCarrier: carrier._id,
        assignedAt,
        assignedBy: actor.assignedBy
      }
    },
    { returnDocument: "after" }
  );
  if (!claimed) {
    const err = new Error('Load is no longer available for assignment (already assigned or modified)');
    err.statusCode = 409;
    err.code = 'LOAD_CONFLICT';
    throw err;
  }

  let snapshot;
  try {
    snapshot = await AssignedModel.create(snapshotPayload);
  } catch (snapshotError) {
    // Compensating release: free the claim so no orphan ASSIGNED-without-audit.
    try {
      await LoadModel.findOneAndUpdate(
        { _id: load._id, auditSnapshotId: { $exists: false } },
        { $set: { status: 'POSTED' }, $unset: { assignedCarrier: '', assignedAt: '', assignedBy: '' } }
      );
    } catch (releaseError) {
      snapshotError.releaseError = releaseError.message;
    }
    // Duplicate approval (unique backstop hit) -> 409 conflict.
    if (snapshotError.code === 11000) {
      const conflict = new Error('Assignment already recorded for this load (conflict)');
      conflict.statusCode = 409;
      conflict.code = 'ASSIGNMENT_CONFLICT';
      conflict.releaseError = snapshotError.releaseError;
      throw conflict;
    }
    throw snapshotError;
  }

  // Link load to its ACTIVE snapshot; if link fails, release claim + remove snapshot.
  const linked = await LoadModel.findOneAndUpdate(
    { _id: load._id, status: 'ASSIGNED' },
    { $set: { auditSnapshotId: snapshot._id } },
    { returnDocument: "after" }
  );
  if (!linked) {
    try { await AssignedModel.findByIdAndDelete(snapshot._id); } catch (e) { /* logged via error */ }
    try {
      await LoadModel.findOneAndUpdate(
        { _id: load._id },
        { $set: { status: 'POSTED' }, $unset: { assignedCarrier: '', assignedAt: '', assignedBy: '', auditSnapshotId: '' } }
      );
    } catch (e) { /* best effort */ }
    const err = new Error('Failed to link audit snapshot; assignment rolled back');
    err.statusCode = 500;
    err.code = 'SNAPSHOT_LINK_FAILED';
    throw err;
  }

  return { snapshot, loadMutated: true };
};

/**
 * Full assignment workflow: evaluate -> decide -> persist consistently.
 * actor/override identity must be the verified JWT user (enforced by route).
 */
const assignCarrierToLoad = async (params) => {
  const load = params.load;
  const carrier = params.carrier;
  const actor = params.actor || {};
  const override = params.override || {};
  const loadModel = params.loadModel;
  const assignmentModel = params.assignmentModel || CarrierAssignment;
  if (!load) {
    const err = new Error('Load is required');
    err.statusCode = 400;
    throw err;
  }
  if (!carrier) {
    const err = new Error('Carrier is required');
    err.statusCode = 400;
    throw err;
  }
  // C1: assignedBy/actorRole must be server-verified; never default silently.
  const assignedBy = actor.assignedBy ? String(actor.assignedBy).trim() : '';
  const actorRole = normalizeRole(actor.actorRole || actor.role);
  if (!assignedBy) {
    const err = new Error('Verified actor identity is required');
    err.statusCode = 401;
    err.code = 'ACTOR_REQUIRED';
    throw err;
  }
  const evaluation = evaluateCarrierForLoad(carrier, load, new Date());
  const decision = decideAssignment(evaluation, {
    actorRole,
    overrideReason: override.overrideReason,
    authorizedBy: assignedBy,
    allowOverride: override.allowOverride
  });
  const result = await persistAssignmentConsistently({
    load, carrier, evaluation,
    actor: { assignedBy, actorRole },
    decision, loadModel, assignmentModel
  });
  return { evaluation, decision, snapshot: result.snapshot };
};

module.exports.decideAssignment = decideAssignment;
module.exports.persistAssignmentConsistently = persistAssignmentConsistently;
module.exports.buildSnapshotChecks = buildSnapshotChecks;
module.exports.normalizeRole = normalizeRole;
module.exports.PRIVILEGED_OVERRIDE_ROLES = PRIVILEGED_OVERRIDE_ROLES;
module.exports.assignCarrierToLoad = assignCarrierToLoad;


