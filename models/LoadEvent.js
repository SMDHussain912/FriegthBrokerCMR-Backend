const mongoose = require('mongoose');

const loadEventSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  load: { type: mongoose.Schema.Types.ObjectId, ref: 'Load', required: true, index: true },
  type: { type: String, required: true, trim: true, index: true }, // milestone, exception, note, status_change, financial, dispatch, tender
  status: { type: String, trim: true },
  summary: { type: String, trim: true },
  details: { type: mongoose.Schema.Types.Mixed },
  occurredAt: { type: Date, default: Date.now, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorRole: { type: String, trim: true },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

loadEventSchema.index({ company: 1, load: 1, occurredAt: -1 });

module.exports = mongoose.model('LoadEvent', loadEventSchema);
