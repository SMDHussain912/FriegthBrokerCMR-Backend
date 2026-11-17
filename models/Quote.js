const mongoose = require('mongoose');

const lineItemSchema = new mongoose.Schema({
  description: { type: String, trim: true },
  equipmentType: { type: String, trim: true },
  origin: { city: String, state: String, postalCode: String, country: { type: String, default: 'US' } },
  destination: { city: String, state: String, postalCode: String, country: { type: String, default: 'US' } },
  quantity: { type: Number, min: 0, default: 1 },
  rate: { type: Number, min: 0 },
  amount: { type: Number, min: 0 },
  notes: { type: String, trim: true }
}, { _id: false });

const quoteSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
  opportunity: { type: mongoose.Schema.Types.ObjectId, ref: 'Opportunity', index: true },
  quoteNumber: { type: String, trim: true, index: true },
  status: { type: String, enum: ['draft', 'sent', 'accepted', 'rejected', 'expired', 'converted'], default: 'draft', index: true },
  currency: { type: String, default: 'USD' },
  lineItems: [lineItemSchema],
  subtotal: { type: Number, min: 0, default: 0 },
  total: { type: Number, min: 0, default: 0 },
  validUntil: { type: Date },
  notes: { type: String, trim: true },
  terms: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

quoteSchema.index({ company: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Quote', quoteSchema);
