const mongoose = require('mongoose');

const tenderSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  load: { type: mongoose.Schema.Types.ObjectId, ref: 'Load', required: true, index: true },
  carrier: { type: mongoose.Schema.Types.ObjectId, ref: 'Carrier', required: true, index: true },
  status: { type: String, enum: ['tendered', 'accepted', 'rejected', 'cancelled', 'expired'], default: 'tendered', index: true },
  rateOffered: { type: Number, min: 0 },
  currency: { type: String, default: 'USD' },
  notes: { type: String, trim: true },
  expiresAt: { type: Date },
  respondedAt: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

tenderSchema.index({ company: 1, load: 1, carrier: 1, status: 1 });

module.exports = mongoose.model('Tender', tenderSchema);
