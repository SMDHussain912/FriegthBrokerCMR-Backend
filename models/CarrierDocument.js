const mongoose = require('mongoose');

const DOCUMENT_TYPES = [
  'CERTIFICATE_OF_INSURANCE',
  'AUTO_LIABILITY',
  'GENERAL_LIABILITY',
  'CARGO_INSURANCE',
  'WORKERS_COMPENSATION',
  'OPERATING_AUTHORITY',
  'W9',
  'OTHER'
];

const DOCUMENT_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'];

const carrierDocumentSchema = new mongoose.Schema({
  carrier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Carrier',
    required: true
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: function() {
      return !this.isDemoData;
    }
  },
  documentType: {
    type: String,
    enum: DOCUMENT_TYPES,
    required: true
  },
  customDocumentType: {
    type: String,
    trim: true,
    maxlength: 100
  },
  originalFilename: {
    type: String,
    required: true,
    trim: true,
    maxlength: 255
  },
  storageKey: {
    type: String,
    required: true,
    trim: true
  },
  mimeType: {
    type: String,
    required: true,
    trim: true
  },
  fileSize: {
    type: Number,
    required: true,
    min: 0
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  uploadedAt: {
    type: Date,
    default: Date.now,
    required: true
  },
  expirationDate: Date,
  verificationStatus: {
    type: String,
    enum: DOCUMENT_VERIFICATION_STATUSES,
    default: 'PENDING',
    required: true
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  verifiedAt: Date,
  rejectionReason: {
    type: String,
    maxlength: 1000
  },
  version: {
    type: Number,
    default: 1,
    min: 1
  },
  previousVersion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CarrierDocument'
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
  isDemoData: {
    type: Boolean,
    default: false
  },
  auditLog: {
    type: [{
      action: {
        type: String,
        enum: ['UPLOADED', 'UPDATED', 'VERIFIED', 'REJECTED', 'ARCHIVED', 'VERSIONED'],
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
    }],
    default: [],
    select: false
  }
}, { timestamps: true });

// Tenant-scoped indexes
carrierDocumentSchema.index({ company: 1, carrier: 1, isArchived: 1, uploadedAt: -1 });
carrierDocumentSchema.index({ company: 1, documentType: 1, verificationStatus: 1 });
carrierDocumentSchema.index({ storageKey: 1 }, { unique: true });
carrierDocumentSchema.index({ company: 1, expirationDate: 1 });
carrierDocumentSchema.index({ company: 1, isDemoData: 1, isArchived: 1 });

carrierDocumentSchema.methods.addAuditEntry = function(action, actor, changedFields, reason) {
  this.auditLog = [
    ...this.auditLog,
    { action, actor, changedFields: changedFields || [], reason, occurredAt: new Date() }
  ].slice(-100);
};

carrierDocumentSchema.statics.scopeForCompany = function(companyId, includeDemo = false) {
  const filter = { company: companyId };
  if (!includeDemo) {
    filter.isDemoData = false;
  }
  return filter;
};

module.exports = mongoose.model('CarrierDocument', carrierDocumentSchema);