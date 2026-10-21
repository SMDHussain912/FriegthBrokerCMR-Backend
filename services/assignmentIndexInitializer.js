const mongoose = require('mongoose');
const CarrierAssignment = require('../models/CarrierAssignment');
const Load = require('../models/Load');

/**
 * Assignment index initializer.
 *
 * Guarantees the "at most one APPROVED/OVERRIDDEN snapshot per load" backstop
 * is actually present in the running database, not just declared in the schema.
 *
 * Failure modes this handles (a bare `syncIndexes()` does not):
 *  1. The index was never created (autoIndex disabled / fresh deployment).
 *  2. Legacy data already contains duplicate approvals for one load, which
 *     makes the unique index build fail with E11000 / IndexKeySpecsConflict.
 *  3. The index exists with a stale (non-unique) definition.
 *
 * Legacy duplicates are NOT deleted. The approval the load actually points at
 * (else the earliest) is kept ACTIVE and the others are demoted to
 * SUPERSEDED, preserving the full audit trail.
 */

const APPROVAL_DECISIONS = ['APPROVED', 'OVERRIDDEN'];
const UNIQUE_INDEX_NAME = 'uniq_approval_per_load';

/**
 * Demote duplicate approvals so the unique partial index can be built.
 */
const demoteDuplicateApprovals = async (assignmentModel, loadModel) => {
  const summary = { loadsScanned: 0, demoted: [] };

  const duplicates = await assignmentModel.aggregate([
    { $match: { assignmentDecision: { $in: APPROVAL_DECISIONS } } },
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: '$loadId',
        count: { $sum: 1 },
        ids: { $push: '$_id' }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]);

  for (const group of duplicates) {
    summary.loadsScanned += 1;
    const load = await loadModel.findById(group._id).select('auditSnapshotId').lean();
    const ids = group.ids.map((id) => new mongoose.Types.ObjectId(String(id)));

    // Prefer the snapshot the load explicitly points at; else keep the earliest.
    let keepId = ids[0];
    if (load && load.auditSnapshotId && ids.some((id) => id.equals(load.auditSnapshotId))) {
      keepId = ids.find((id) => id.equals(load.auditSnapshotId));
    }

    const demoteIds = ids.filter((id) => !id.equals(keepId));
    const res = await assignmentModel.updateMany(
      { _id: { $in: demoteIds } },
      {
        $set: {
          assignmentDecision: 'SUPERSEDED',
          supersededAt: new Date(),
          supersededReason: 'Legacy duplicate approval demoted during unique-index initialization'
        }
      }
    );
    summary.demoted.push({
      loadId: String(group._id),
      demotedCount: res.modifiedCount,
      keptSnapshotId: String(keepId)
    });
  }

  return summary;
};

/**
 * Ensure the unique partial approval index exists and is enforced.
 * Safe to call repeatedly (idempotent).
 */
const ensureAssignmentIndexes = async (options = {}) => {
  const assignmentModel = options.assignmentModel || CarrierAssignment;
  const loadModel = options.loadModel || Load;
  const logger = options.logger || console;

  const repair = await demoteDuplicateApprovals(assignmentModel, loadModel);
  const demotedTotal = repair.demoted.reduce((n, d) => n + d.demotedCount, 0);
  if (demotedTotal > 0) {
    logger.warn(
      `[IndexInit] Demoted ${demotedTotal} legacy duplicate approval snapshot(s) across ` +
      `${repair.loadsScanned} load(s) to SUPERSEDED (audit trail preserved).`
    );
  }

  // syncIndexes() drops indexes absent from the schema and (re)creates the
  // declared ones — including the partial unique approval index.
  await assignmentModel.syncIndexes();

  const indexes = await assignmentModel.collection.indexes();
  const guard = indexes.find((idx) => idx.name === UNIQUE_INDEX_NAME);
  if (!guard) {
    const err = new Error(`Critical: unique approval index "${UNIQUE_INDEX_NAME}" was not created`);
    err.code = 'ASSIGNMENT_INDEX_MISSING';
    throw err;
  }
  if (!guard.unique) {
    const err = new Error(`Critical: index "${UNIQUE_INDEX_NAME}" exists but is not unique`);
    err.code = 'ASSIGNMENT_INDEX_NOT_UNIQUE';
    throw err;
  }
  logger.log(`[IndexInit] Unique approval index "${UNIQUE_INDEX_NAME}" is active.`);

  // Load indexes used by the active-assignment endpoint.
  await loadModel.syncIndexes();

  return { repair, indexes };
};

module.exports = {
  ensureAssignmentIndexes,
  demoteDuplicateApprovals,
  APPROVAL_DECISIONS,
  UNIQUE_INDEX_NAME
};
