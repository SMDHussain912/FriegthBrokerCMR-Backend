const mongoose = require('mongoose');

const auditEventSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    index: true
  },
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  actorRole: { type: String },
  action: { type: String, required: true, trim: true, index: true },
  entityType: { type: String, required: true, trim: true, index: true },
  entityId: { type: String, trim: true, index: true },
  summary: { type: String, trim: true },
  changes: {
    type: mongoose.Schema.Types.Mixed
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'critical'],
    default: 'info'
  },
  isDemoData: { type: Boolean, default: false, index: true },
  occurredAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

auditEventSchema.index({ company: 1, occurredAt: -1 });
auditEventSchema.index({ company: 1, entityType: 1, entityId: 1, occurredAt: -1 });

// Audit events are append-only records.
const blockMutation = () => {
  throw new Error('Audit events are append-only and cannot be modified or removed');
};
for (const hook of [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndDelete',
  'findOneAndRemove', 'deleteOne', 'deleteMany', 'replaceOne'
]) {
  auditEventSchema.pre(hook, blockMutation);
}
auditEventSchema.pre('save', function() {
  if (!this.isNew) {
    throw new Error('Audit events are append-only and cannot be modified');
  }
});
auditEventSchema.pre('remove', blockMutation);

module.exports = mongoose.model('AuditEvent', auditEventSchema);
