const mongoose = require('mongoose');

const laneSchema = new mongoose.Schema({
  originCity: String, originState: String, originPostalCode: String,
  destinationCity: String, destinationState: String, destinationPostalCode: String,
  equipmentType: { type: String, trim: true },
  rateType: { type: String, enum: ['flat', 'per_mile', 'per_cwt', 'other'], default: 'flat' },
  rateAmount: { type: Number, min: 0 },
  fuelSurcharge: { type: Number, min: 0 },
  minimumCharge: { type: Number, min: 0 },
  notes: { type: String, trim: true }
}, { _id: false });

const rateAgreementSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
  name: { type: String, required: true, trim: true },
  status: { type: String, enum: ['draft', 'active', 'expired', 'terminated'], default: 'draft', index: true },
  effectiveDate: { type: Date },
  expirationDate: { type: Date },
  currency: { type: String, default: 'USD' },
  paymentTerms: { type: String, trim: true },
  lanes: [laneSchema],
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

rateAgreementSchema.index({ company: 1, customer: 1, status: 1 });

module.exports = mongoose.model('RateAgreement', rateAgreementSchema);
