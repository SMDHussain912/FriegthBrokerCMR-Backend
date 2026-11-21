const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  type: {
    type: String,
    enum: ['info', 'warning', 'success', 'error', 'assignment', 'tender', 'exception', 'payment', 'compliance', 'system'],
    required: true,
    index: true
  },
  title: { type: String, required: true, trim: true },
  message: { type: String, required: true, trim: true },
  isRead: { type: Boolean, default: false, index: true },
  readAt: { type: Date },
  relatedEntityType: { type: String, trim: true },
  relatedEntityId: { type: mongoose.Schema.Types.ObjectId, trim: true },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ company: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ user: 1, type: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
