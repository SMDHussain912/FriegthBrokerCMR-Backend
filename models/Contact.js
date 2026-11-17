const mongoose = require('mongoose');

const communicationSchema = new mongoose.Schema({
  type: { type: String, enum: ['note', 'call', 'email', 'sms', 'meeting', 'other'], default: 'note' },
  subject: { type: String, trim: true },
  body: { type: String, trim: true },
  occurredAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  metadata: { type: mongoose.Schema.Types.Mixed }
}, { _id: true, timestamps: true });

const contactSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
  name: { type: String, required: true, trim: true },
  title: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  mobile: { type: String, trim: true },
  isPrimary: { type: Boolean, default: false },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  notes: { type: String, trim: true },
  communications: [communicationSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

contactSchema.index({ company: 1, customer: 1, name: 1 });

module.exports = mongoose.model('Contact', contactSchema);
