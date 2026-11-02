const mongoose = require('mongoose');

const companySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Company name is required'],
    trim: true,
    index: true
  },
  slug: {
    type: String,
    required: [true, 'Company slug is required'],
    trim: true,
    unique: true,
    lowercase: true
  },
  type: {
    type: String,
    enum: ['brokerage', 'carrier', 'platform'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'verified', 'active', 'suspended'],
    default: 'pending'
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  contact: {
    phone: String,
    email: {
      type: String,
      lowercase: true,
      trim: true
    },
    address: {
      street: String,
      city: String,
      state: String,
      zip: String
    }
  },
  metadata: {
    type: Map,
    of: String
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

companySchema.index({ slug: 1 }, { unique: true });
companySchema.index({ status: 1 });

module.exports = mongoose.model('Company', companySchema);
