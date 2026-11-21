const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  idempotencyKey: { type: String, trim: true, index: true },
  type: { type: String, required: true, trim: true, index: true },
  status: {
    type: String,
    enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  result: { type: mongoose.Schema.Types.Mixed },
  error: { type: String, trim: true },
  errorDetails: { type: mongoose.Schema.Types.Mixed },
  maxRetries: { type: Number, default: 3, min: 0, max: 10 },
  retryCount: { type: Number, default: 0, min: 0 },
  retryDelayMs: { type: Number, default: 1000, min: 0 },
  scheduledAt: { type: Date, default: Date.now, index: true },
  startedAt: { type: Date },
  completedAt: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

// Indexes for job queue processing
jobSchema.index({ company: 1, status: 1, scheduledAt: 1 });
jobSchema.index({ company: 1, type: 1, status: 1 });
jobSchema.index({ idempotencyKey: 1, company: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true, $ne: null }, isDemoData: false } });
jobSchema.index({ status: 1, scheduledAt: 1, company: 1 });

jobSchema.methods.isRetryable = function () {
  return this.status === 'failed' && this.retryCount < this.maxRetries;
};

jobSchema.methods.nextRetryDelay = function () {
  // Exponential backoff: delay * 2^retryCount, capped at 1 hour
  const base = this.retryDelayMs || 1000;
  return Math.min(base * Math.pow(2, this.retryCount), 3600000);
};

module.exports = mongoose.model('Job', jobSchema);
