const mongoose = require('mongoose');

const auditEntrySchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ['CREATED', 'UPDATED', 'EVALUATED'],
    required: true
  },
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  changedFields: [{ type: String }],
  reason: String,
  metadata: mongoose.Schema.Types.Mixed,
  occurredAt: {
    type: Date,
    default: Date.now,
    required: true
  }
}, { _id: false });

const vettingConfigurationSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    unique: true
  },
  brokerage: {
    type: String,
    trim: true
  },
  minimumAuthorityDays: {
    type: Number,
    default: 30,
    min: 1
  },
  maximumOutOfServicePercentiles: {
    type: Number,
    default: 20,
    min: 0,
    max: 100
  },
  minimumLiabilityLimit: {
    type: Number,
    default: 100000,
    min: 0
  },
  requiredInsuranceDocuments: {
    type: [String],
    default: ['insurance_certificate', 'authority_letter']
  },
  minimumCargoLimit: {
    type: Number,
    default: 100000,
    min: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  auditLog: {
    type: [auditEntrySchema],
    default: [],
    select: false
  },
  lastModified: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

vettingConfigurationSchema.pre('save', function() {
  this.lastModified = Date.now();
});

module.exports = mongoose.model('VettingConfiguration', vettingConfigurationSchema);
