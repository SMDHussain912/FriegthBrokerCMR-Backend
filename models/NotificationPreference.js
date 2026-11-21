const mongoose = require('mongoose');

const notificationPreferenceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },
  // Channel-level opt-in flags
  email: { type: Boolean, default: true },
  sms: { type: Boolean, default: false },
  push: { type: Boolean, default: true },
  // Type-level opt-in flags (per notification type)
  types: {
    assignment: { type: Boolean, default: true },
    tender: { type: Boolean, default: true },
    exception: { type: Boolean, default: true },
    payment: { type: Boolean, default: true },
    compliance: { type: Boolean, default: true },
    system: { type: Boolean, default: true },
    info: { type: Boolean, default: true },
    warning: { type: Boolean, default: true },
    error: { type: Boolean, default: true },
    success: { type: Boolean, default: true },
  },
  // Quiet hours (do not disturb) window in local time
  quietHours: {
    enabled: { type: Boolean, default: false },
    start: { type: String, trim: true }, // "22:00"
    end: { type: String, trim: true },   // "08:00"
    timezone: { type: String, trim: true, default: 'UTC' }
  },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

// One preference record per user per company
notificationPreferenceSchema.index({ user: 1, company: 1 }, { unique: true, name: 'user_company_unique' });
notificationPreferenceSchema.index({ company: 1, isDemoData: 1 });

module.exports = mongoose.model('NotificationPreference', notificationPreferenceSchema);
