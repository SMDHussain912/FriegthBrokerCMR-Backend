const mongoose = require('mongoose');

const invitationSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true
  },
  role: {
    type: String,
    required: true,
    trim: true
  },
  tokenHash: {
    type: String,
    required: true,
    select: false
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'revoked', 'expired'],
    default: 'pending',
    index: true
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  acceptedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  acceptedAt: { type: Date },
  revokedAt: { type: Date },
  expiresAt: { type: Date, required: true, index: true },
  message: { type: String, trim: true },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

invitationSchema.index({ company: 1, email: 1, status: 1 });
invitationSchema.index({ company: 1, createdAt: -1 });

module.exports = mongoose.model('Invitation', invitationSchema);
