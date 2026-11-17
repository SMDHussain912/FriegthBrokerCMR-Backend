const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  type: { type: String, enum: ['note', 'call', 'email', 'meeting', 'task', 'follow_up', 'status_change'], default: 'note' },
  subject: { type: String, trim: true },
  body: { type: String, trim: true },
  dueAt: { type: Date },
  completedAt: { type: Date },
  status: { type: String, enum: ['open', 'done', 'cancelled'], default: 'open' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  occurredAt: { type: Date, default: Date.now }
}, { _id: true, timestamps: true });

const leadSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
  name: { type: String, required: true, trim: true },
  companyName: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  source: { type: String, trim: true },
  stage: { type: String, enum: ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'], default: 'new', index: true },
  estimatedValue: { type: Number, min: 0 },
  probability: { type: Number, min: 0, max: 100 },
  expectedCloseDate: { type: Date },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  notes: { type: String, trim: true },
  activities: [activitySchema],
  lostReason: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

leadSchema.index({ company: 1, stage: 1, updatedAt: -1 });

module.exports = mongoose.model('Lead', leadSchema);
