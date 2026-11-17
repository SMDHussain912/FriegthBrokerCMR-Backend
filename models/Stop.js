const mongoose = require('mongoose');

const stopSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  load: { type: mongoose.Schema.Types.ObjectId, ref: 'Load', required: true, index: true },
  sequence: { type: Number, required: true, min: 1 },
  type: { type: String, enum: ['pickup', 'delivery', 'stop'], default: 'pickup' },
  name: { type: String, trim: true },
  address: {
    line1: String, line2: String, city: String, state: String, postalCode: String, country: { type: String, default: 'US' }
  },
  appointmentStart: { type: Date },
  appointmentEnd: { type: Date },
  arrivedAt: { type: Date },
  departedAt: { type: Date },
  status: { type: String, enum: ['pending', 'arrived', 'departed', 'completed', 'skipped'], default: 'pending', index: true },
  notes: { type: String, trim: true },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

stopSchema.index({ company: 1, load: 1, sequence: 1 }, { unique: true });

module.exports = mongoose.model('Stop', stopSchema);
