const mongoose = require('mongoose');

const insurancePolicySubSchema = new mongoose.Schema({
  policyType: {
    type: String,
    enum: ['AUTO_LIABILITY', 'CARGO', 'GENERAL_LIABILITY'],
    required: [true, 'Policy type is required']
  },
  insuranceProvider: {
    type: String,
    required: [true, 'Insurance provider is required'],
    trim: true
  },
  policyNumber: {
    type: String,
    required: [true, 'Policy number is required'],
    trim: true
  },
  coverageLimit: {
    type: Number,
    required: [true, 'Coverage limit is required'],
    min: [0, 'Coverage limit cannot be negative']
  },
  effectiveDate: {
    type: Date,
    required: [true, 'Effective date is required']
  },
  expirationDate: {
    type: Date,
    required: [true, 'Expiration date is required']
  },
  reeferBreakdownEndorsement: {
    type: Boolean,
    default: false
  },
  hasUnattendedVehicleClause: {
    type: Boolean,
    default: false
  },
  verificationStatus: {
    type: String,
    enum: ['VERIFIED', 'UNVERIFIED', 'EXPIRED', 'REJECTED'],
    default: 'UNVERIFIED',
    required: true
  },
  verifiedBy: {
    type: String
  },
  verifiedAt: {
    type: Date
  },
  verificationNotes: {
    type: String
  },
  producerContact: {
    name: String,
    phone: String,
    email: String
  },
  uploadedDocumentUri: {
    type: String
  }
}, { _id: true, timestamps: true });

const carrierAuditSubSchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ['CREATED', 'UPDATED', 'ARCHIVED'],
    required: true
  },
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  changedFields: [{ type: String }],
  reason: String,
  occurredAt: {
    type: Date,
    default: Date.now,
    required: true
  }
}, { _id: false });

const carrierSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: function() {
      return !this.isDemoData;
    }
  },
  dotNumber: {
    type: String,
    required: [true, 'USDOT number is required'],
    trim: true
  },
  mcNumber: {
    type: String,
    required: [true, 'MC/FF number is required'],
    trim: true
  },
  legalName: {
    type: String,
    required: [true, 'Legal business name is required'],
    trim: true
  },
  dbaName: {
    type: String,
    trim: true
  },
  contact: {
    phone: String,
    email: String,
    address: {
      street: String,
      city: String,
      state: String,
      zip: String
    }
  },
  contacts: [{
    name: { type: String, trim: true },
    title: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    mobile: { type: String, trim: true },
    isPrimary: { type: Boolean, default: false },
    department: { type: String, trim: true }
  }],
  equipment: [{
    type: { type: String, trim: true, enum: ['tractor', 'trailer', 'reefer', 'flatbed', 'tanker', 'other'] },
    unitNumber: { type: String, trim: true },
    vin: { type: String, trim: true },
    licensePlate: { type: String, trim: true },
    state: { type: String, trim: true },
    year: { type: Number, min: 1900, max: 2100 },
    make: { type: String, trim: true },
    model: { type: String, trim: true },
    status: { type: String, enum: ['active', 'inactive', 'maintenance', 'retired'], default: 'active' },
    purchaseDate: { type: Date },
    insuranceExpiration: { type: Date },
    inspectionDue: { type: Date }
  }],
  drivers: [{
    name: { type: String, trim: true },
    cdlNumber: { type: String, trim: true },
    cdlClass: { type: String, enum: ['A', 'B', 'C'], trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    hireDate: { type: Date },
    status: { type: String, enum: ['active', 'on_leave', 'terminated', 'probation'], default: 'active' },
    medicalExpiration: { type: Date },
    cdlExpiration: { type: Date },
    isOwnerOperator: { type: Boolean, default: false }
  }],
  authorityStatus: {
    type: String,
    enum: ['ACTIVE', 'REVOKED', 'INACTIVE', 'PENDING'],
    default: 'ACTIVE',
    required: true
  },
  authorityGrantDate: {
    type: Date,
    required: [true, 'Operating authority grant date is required']
  },
  safetyRating: {
    type: String,
    enum: ['SATISFACTORY', 'CONDITIONAL', 'UNSATISFACTORY', 'NONE'],
    default: 'NONE',
    required: true
  },
  fmcsaMetrics: {
    unsafeDrivingPercentile: { type: Number, default: 0, min: 0, max: 100 },
    hosCompliancePercentile: { type: Number, default: 0, min: 0, max: 100 },
    vehicleMaintPercentile: { type: Number, default: 0, min: 0, max: 100 },
    crashTotal: { type: Number, default: 0, min: 0 },
    lastFmcsaCheck: { type: Date, default: Date.now }
  },
  insurancePolicies: [insurancePolicySubSchema],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  isArchived: {
    type: Boolean,
    default: false
  },
  archivedAt: Date,
  archivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  auditLog: {
    type: [carrierAuditSubSchema],
    default: [],
    select: false
  },
  fraudSignals: {
    domainMatchVerified: { type: Boolean, default: true },
    virtualOfficeDetected: { type: Boolean, default: false }
  },
  // Clearly labelled demo data identifier
  isDemoData: {
    type: Boolean,
    default: false
  },
  overallStatus: {
    type: String,
    enum: ['PASS', 'FAIL', 'NEEDS_REVIEW', 'UNKNOWN'],
    default: 'UNKNOWN'
  }
}, { timestamps: true });

// Scoped compound unique index per company for real carriers
carrierSchema.index(
  { company: 1, dotNumber: 1 },
  { unique: true, partialFilterExpression: { company: { $exists: true, $type: "objectId" }, isDemoData: false } }
);
carrierSchema.index(
  { company: 1, mcNumber: 1 },
  { unique: true, partialFilterExpression: { company: { $exists: true, $type: "objectId" }, isDemoData: false } }
);
carrierSchema.index({ company: 1, isDemoData: 1, isArchived: 1, legalName: 1 });
carrierSchema.index({ company: 1, 'equipment.unitNumber': 1 });
carrierSchema.index({ company: 1, 'drivers.cdlNumber': 1 });
carrierSchema.index({ company: 1, 'contacts.email': 1 });

// Global unique index for demo carriers (company is null/undefined)
carrierSchema.index(
  { dotNumber: 1 },
  { unique: true, partialFilterExpression: { isDemoData: true } }
);
carrierSchema.index(
  { mcNumber: 1 },
  { unique: true, partialFilterExpression: { isDemoData: true } }
);

module.exports = mongoose.model('Carrier', carrierSchema);
