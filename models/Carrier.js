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

const carrierSchema = new mongoose.Schema({
  dotNumber: {
    type: String,
    required: [true, 'USDOT number is required'],
    unique: true,
    trim: true,
    index: true
  },
  mcNumber: {
    type: String,
    required: [true, 'MC/FF number is required'],
    trim: true,
    index: true
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
  fraudSignals: {
    domainMatchVerified: { type: Boolean, default: true },
    virtualOfficeDetected: { type: Boolean, default: false }
  },
  // Clearly labelled demo data identifier
  isDemoData: {
    type: Boolean,
    default: true
  },
  overallStatus: {
    type: String,
    enum: ['PASS', 'FAIL', 'NEEDS_REVIEW', 'UNKNOWN'],
    default: 'UNKNOWN'
  }
}, { timestamps: true });

module.exports = mongoose.model('Carrier', carrierSchema);
