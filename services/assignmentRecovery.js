const CarrierAssignment = require('../models/CarrierAssignment');
const Load = require('../models/Load');

/**
 * Assignment crash recovery.
 *
 * The assignment flow is a two-step write on standalone MongoDB (no
 * multi-document transactions):
 *   1. atomic load claim  (POSTED -> ASSIGNED)
 *   2. approval snapshot creation + link (load.auditSnapshotId)
 *
 * A process crash between (1) and (2) can leave a load in ASSIGNED with no
 * active audit snapshot. Such a load is stuck: it can never be reassigned
 * (status != POSTED) yet has no due-diligence certificate.
 *
 * This reconciler repairs that state at startup:
 *  - load ASSIGNED + approval snapshot exists  -> link the snapshot (repair)
 *  - load ASSIGNED + no snapshot at all        -> release back to POSTED
 *
 * REJECTED-only snapshots do not release the claim (they are audit-only and
 * never claimed the load), so those loads are released to POSTED as well.
 */

const APPROVAL_DECISIONS = ['APPROVED', 'OVERRIDDEN'];

/**
 * @returns {Promise<{repaired: number, released: number, details: Array}>}
 */
const reconcileOrphanedAssignments = async (options = {}) => {
  const loadModel = options.loadModel || Load;
  const assignmentModel = options.assignmentModel || CarrierAssignment;
  const logger = options.logger || console;

  const details = [];
  let repaired = 0;
  let released = 0;

  const orphaned = await loadModel.find({
    status: 'ASSIGNED',
    $or: [
      { auditSnapshotId: { $exists: false } },
      { auditSnapshotId: null }
    ]
  });

  for (const load of orphaned) {
    const approval = await assignmentModel.findOne({
      loadId: load._id,
      assignmentDecision: { $in: APPROVAL_DECISIONS }
    });

    if (approval) {
      // The snapshot survived but the link did not -> finish the link.
      const linked = await loadModel.findOneAndUpdate(
        { _id: load._id, status: 'ASSIGNED' },
        { $set: { auditSnapshotId: approval._id } },
        { returnDocument: 'after' }
      );
      if (linked) {
        repaired += 1;
        details.push({ loadId: String(load._id), action: 'linked', snapshotId: String(approval._id) });
        continue;
      }
    }

    // No approval snapshot -> the claim never completed. Release the load.
    const releasedLoad = await loadModel.findOneAndUpdate(
      { _id: load._id, status: 'ASSIGNED' },
      {
        $set: { status: 'POSTED' },
        $unset: { assignedCarrier: '', assignedAt: '', assignedBy: '', auditSnapshotId: '' }
      },
      { returnDocument: 'after' }
    );
    if (releasedLoad) {
      released += 1;
      details.push({ loadId: String(load._id), loadNumber: load.loadNumber, action: 'released' });
    }
  }

  if (repaired > 0 || released > 0) {
    logger.warn(
      `[Recovery] Reconciled orphaned assignments: ${repaired} linked, ${released} released back to POSTED.`
    );
  }

  return { repaired, released, details };
};

module.exports = { reconcileOrphanedAssignments, APPROVAL_DECISIONS };
