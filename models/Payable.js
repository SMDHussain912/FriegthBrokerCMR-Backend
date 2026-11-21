const mongoose = require('mongoose');

const payableLineItemSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true },
  quantity: { type: Number, required: true, min: 0, default: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
  amount: { type: Number, required: true, min: 0 },
  loadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Load', trim: true },
  loadNumber: { type: String, trim: true }
}, { _id: true });

const payableSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  carrier: { type: mongoose.Schema.Types.ObjectId, ref: 'Carrier', required: true, index: true },
  payableNumber: { type: String, required: true, trim: true, index: true },
  status: {
    type: String,
    enum: ['draft', 'approved', 'paid', 'void'],
    default: 'draft',
    index: true
  },
  currency: { type: String, trim: true, uppercase: true, default: 'USD', index: true },
  issueDate: { type: Date, default: Date.now },
  dueDate: { type: Date },
  lineItems: [payableLineItemSchema],
  amount: { type: Number, min: 0, default: 0 },
  paidAmount: { type: Number, min: 0, default: 0 },
  notes: { type: String, trim: true },
  linkedLoads: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Load' }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

// Unique payable number per company.
payableSchema.index({ company: 1, payableNumber: 1 }, { unique: true, name: 'company_payableNumber_unique' });
payableSchema.index({ company: 1, status: 1, dueDate: 1 });
payableSchema.index({ company: 1, carrier: 1, status: 1 });

payableSchema.pre('save', function (next) {
  // Recompute totals from line items.
  let amount = 0;
  for (const item of this.lineItems || []) {
    const qty = Number(item.quantity || 0);
    const price = Number(item.unitPrice || 0);
    item.amount = qty * price;
    amount += item.amount;
  }
  this.amount = amount;
  this.paidAmount = Math.min(this.paidAmount || 0, amount);
  next();
});

payableSchema.methods.balanceDue = function () {
  return Math.max(0, Number(this.amount || 0) - Number(this.paidAmount || 0));
};

payableSchema.methods.isOverdue = function () {
  if (this.status === 'paid' || this.status === 'void') return false;
  if (!this.dueDate) return false;
  return new Date() > new Date(this.dueDate);
};

module.exports = mongoose.model('Payable', payableSchema);
