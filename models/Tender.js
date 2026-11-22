const mongoose = require('mongoose');

/**
 * Tender Model - Carrier load tender management
 * Tracks tender lifecycle: sent -> viewed -> accepted/rejected/expired/withdrawn/countered
 */

const tenderSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  load: { type: mongoose.Schema.Types.ObjectId, ref: 'Load', required: true, index: true },
  loadNumber: { type: String, required: true },
  carrier: { type: mongoose.Schema.Types.ObjectId, ref: 'Carrier', required: true, index: true },
  carrierName: { type: String, required: true },
  // Tender details
  tenderNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
  status: {
    type: String,
    enum: ['SENT', 'VIEWED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN', 'COUNTERED'],
    default: 'SENT',
    index: true
  },
  // Rate offered to carrier (in minor units/cents)
  offeredRate: { type: Number, required: true, min: 0 },
  offeredRatePerMile: { type: Number, min: 0 },
  // Carrier counter-offer
  counterRate: { type: Number, min: 0 },
  counterRatePerMile: { type: Number, min: 0 },
  counterReason: { type: String, trim: true },
  // Timing
  sentAt: { type: Date, default: Date.now },
  viewedAt: { type: Date },
  respondedAt: { type: Date },
  expiresAt: { type: Date, required: true, index: true },
  // Response
  rejectionReason: { type: String, trim: true },
  acceptanceNotes: { type: String, trim: true },
  // Idempotency
  idempotencyKey: { type: String, trim: true, index: true },
  // Audit
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

// Unique tender per load-carrier combination (prevent duplicate tenders)
tenderSchema.index({ load: 1, carrier: 1, status: 1 }, { 
  unique: true, 
  partialFilterExpression: { 
    status: { $in: ['SENT', 'VIEWED', 'ACCEPTED', 'COUNTERED'] }
  }
});

tenderSchema.index({ company: 1, status: 1, sentAt: -1 });
tenderSchema.index({ company: 1, carrier: 1, sentAt: -1 });
tenderSchema.index({ expiresAt: 1, status: 1 }); // For expiry cleanup job

/**
 * Check if tender is expired
 * @returns {boolean}
 */
tenderSchema.methods.isExpired = function() {
  return this.status === 'SENT' && new Date() > this.expiresAt;
};

/**
 * Mark tender as viewed
 * @param {ObjectId} userId - User who viewed
 */
tenderSchema.methods.markViewed = function(userId) {
  if (this.status === 'SENT') {
    this.status = 'VIEWED';
    this.viewedAt = new Date();
  }
};

/**
 * Accept tender
 * @param {ObjectId} userId - User accepting
 * @param {string} notes - Optional acceptance notes
 */
tenderSchema.methods.accept = function(userId, notes = '') {
  if (!['SENT', 'VIEWED'].includes(this.status)) {
    throw new Error(`Cannot accept tender in status: ${this.status}`);
  }
  this.status = 'ACCEPTED';
  this.respondedAt = new Date();
  this.respondedBy = userId;
  this.acceptanceNotes = notes;
};

/**
 * Reject tender
 * @param {ObjectId} userId - User rejecting
 * @param {string} reason - Rejection reason
 */
tenderSchema.methods.reject = function(userId, reason = '') {
  if (!['SENT', 'VIEWED'].includes(this.status)) {
    throw new Error(`Cannot reject tender in status: ${this.status}`);
  }
  this.status = 'REJECTED';
  this.respondedAt = new Date();
  this.respondedBy = userId;
  this.rejectionReason = reason;
};

/**
 * Counter offer
 * @param {ObjectId} userId - User countering
 * @param {number} rate - Counter rate in minor units
 * @param {string} reason - Counter reason
 */
tenderSchema.methods.counter = function(userId, rate, reason = '') {
  if (!['SENT', 'VIEWED'].includes(this.status)) {
    throw new Error(`Cannot counter tender in status: ${this.status}`);
  }
  this.status = 'COUNTERED';
  this.counterRate = rate;
  this.counterReason = reason;
  this.respondedAt = new Date();
  this.respondedBy = userId;
};

/**
 * Withdraw tender (by broker)
 * @param {ObjectId} userId - User withdrawing
 */
tenderSchema.methods.withdraw = function(userId) {
  if (!['SENT', 'VIEWED', 'COUNTERED'].includes(this.status)) {
    throw new Error(`Cannot withdraw tender in status: ${this.status}`);
  }
  this.status = 'WITHDRAWN';
  this.respondedAt = new Date();
  this.respondedBy = userId;
};

/**
 * Expire tender (system job)
 */
tenderSchema.methods.expire = function() {
  if (this.status === 'SENT' || this.status === 'VIEWED') {
    this.status = 'EXPIRED';
  }
};

module.exports = mongoose.model('Tender', tenderSchema);
