const mongoose = require('mongoose');

/**
 * Versioned Audit Snapshot for Carrier Assignment
 *
 * Freezes the complete state of evidence, rule definitions, data sources,
 * timestamps, and assignment decisions at the moment of dispatch.
 *
 * NOTE: All evidence in this MVP is DEMO data (Mock FMCSA SAFER Provider).
 * No live FMCSA queries or real-world insurance verifications are executed.
 */

const evaluatedCheckSchema = new mongoose.Schema({
  ruleKey: { type: String, required: true },
  ruleName: { type: String, required: true },
  status: {
    type: String,
    enum: ['PASS', 'FAIL', 'NEEDS_REVIEW', 'UNKNOWN'],
    required: true
  },
  reasonCode: { type: String },
  requiredValue: { type: mongoose.Schema.Types.Mixed },
  actualValue: { type: mongoose.Schema.Types.Mixed },
  evidenceSource: { type: String, required: true },
  evidenceTimestamp: { type: Date, required: true },
  notes: { type: String }
}, { _id: false });

const carrierAssignmentSchema = new mongoose.Schema({
  loadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Load', required: true, index: true },
  loadNumber: { type: String },
  carrierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Carrier', required: true, index: true },
  carrierName: { type: String },
  // Actor identifier (demo mode: free-form string such as email/name).
  // Stored as String because no User collection exists yet.
  assignedBy: { type: String, required: true },
  actorRole: {
    type: String,
    enum: ['broker', 'compliance_officer', 'admin'],
    default: 'broker',
    required: true
  },
  assignedAt: { type: Date, default: Date.now },
  // H2: sequences audit attempts per load (REJECTED attempts + final approval).
  attemptNumber: { type: Number, default: 1, min: 1 },
  // H2: no default — stamped ONLY from evaluation.ruleVersion at snapshot time.
  ruleVersion: { type: String, required: true },
  overallStatus: {
    type: String,
    enum: ['PASS', 'FAIL', 'NEEDS_REVIEW', 'UNKNOWN'],
    required: true
  },
  assignmentDecision: {
    type: String,
    // SUPERSEDED: legacy duplicate approval demoted during index repair.
    // It preserves the audit trail while releasing the unique-approval slot.
    enum: ['APPROVED', 'OVERRIDDEN', 'REJECTED', 'SUPERSEDED'],
    required: true
  },
  overrideDetails: {
    overrideGranted: { type: Boolean, default: false },
    overrideReason: { type: String },
    authorizedBy: { type: String },
    authorizedRole: { type: String },
    authorizedAt: { type: Date }
  },
  // Set when a legacy duplicate approval is demoted during index repair.
  supersededAt: { type: Date },
  supersededReason: { type: String },
  evaluatedChecks: {
    type: [evaluatedCheckSchema],
    required: true,
    validate: {
      validator: (v) => Array.isArray(v) && v.length > 0,
      message: 'Evaluated checks snapshot must contain at least one check'
    }
  },
  // Clearly labelled demo data identifier
  isDemoData: { type: Boolean, default: true }
}, { timestamps: true });

// C2 backstop: at most one APPROVED/OVERRIDDEN snapshot per load.
// REJECTED attempts are unbounded audit trail; approvals are unique.
carrierAssignmentSchema.index(
  { loadId: 1 },
  {
    unique: true,
    partialFilterExpression: { assignmentDecision: { $in: ['APPROVED', 'OVERRIDDEN'] } },
    name: 'uniq_approval_per_load'
  }
);

module.exports = mongoose.model('CarrierAssignment', carrierAssignmentSchema);
