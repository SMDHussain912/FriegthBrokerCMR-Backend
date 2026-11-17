const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  title: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  isPrimary: { type: Boolean, default: false },
  notes: { type: String, trim: true }
}, { _id: false });

const customerSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['customer', 'shipper', 'consignee', 'both'], default: 'customer', index: true },
  status: { type: String, enum: ['active', 'inactive', 'prospect'], default: 'active', index: true },
  industry: { type: String, trim: true },
  website: { type: String, trim: true },
  phone: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  billingAddress: {
    line1: String, line2: String, city: String, state: String, postalCode: String, country: { type: String, default: 'US' }
  },
  shippingAddress: {
    line1: String, line2: String, city: String, state: String, postalCode: String, country: { type: String, default: 'US' }
  },
  contacts: [contactSchema],
  paymentTerms: { type: String, trim: true },
  creditLimit: { type: Number, min: 0 },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

customerSchema.index({ company: 1, name: 1 });
customerSchema.index({ company: 1, status: 1, type: 1 });

module.exports = mongoose.model('Customer', customerSchema);
