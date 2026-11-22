const mongoose = require('mongoose');

/**
 * Number Sequence Model - Automatic numbering for financial documents
 * 
 * Ensures unique, sequential numbers per company and document type.
 * Supports prefixes, year/month formatting, and custom patterns.
 */

const numberSequenceSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  documentType: { type: String, required: true, enum: ['Invoice', 'Payable', 'Expense', 'CreditNote', 'Load', 'Quote', 'RateAgreement', 'Tender'] },
  prefix: { type: String, required: true, trim: true, uppercase: true },
  pattern: { type: String, default: '{prefix}-{year}{month}-{seq:6}' },
  currentSequence: { type: Number, default: 0, min: 0 },
  minSequence: { type: Number, default: 1 },
  maxSequence: { type: Number, default: 999999 },
  resetPeriod: { type: String, enum: ['never', 'yearly', 'monthly', 'daily'], default: 'monthly' },
  lastResetAt: { type: Date },
  isActive: { type: Boolean, default: true },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

numberSequenceSchema.index({ company: 1, documentType: 1 }, { unique: true, name: 'company_documentType_unique' });

numberSequenceSchema.statics.getNextNumber = async function(companyId, documentType, isDemoData = false) {
  const sequence = await this.findOneAndUpdate(
    { company: companyId, documentType, isDemoData },
    { $inc: { currentSequence: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  
  if (!sequence) throw new Error('Failed to create number sequence');
  
  // Check if reset is needed
  const now = new Date();
  const shouldReset = (
    sequence.resetPeriod === 'yearly' && (!sequence.lastResetAt || sequence.lastResetAt.getFullYear() !== now.getFullYear()) ||
    sequence.resetPeriod === 'monthly' && (!sequence.lastResetAt || sequence.lastResetAt.getMonth() !== now.getMonth() || sequence.lastResetAt.getFullYear() !== now.getFullYear()) ||
    sequence.resetPeriod === 'daily' && (!sequence.lastResetAt || sequence.lastResetAt.getDate() !== now.getDate() || sequence.lastResetAt.getMonth() !== now.getMonth())
  );
  
  if (shouldReset) {
    sequence.currentSequence = sequence.minSequence;
    sequence.lastResetAt = now;
    await sequence.save();
  }
  
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  
  const number = sequence.pattern
    .replace('{prefix}', sequence.prefix)
    .replace('{year}', year)
    .replace('{month}', month)
    .replace('{day}', day)
    .replace('{seq:6}', String(sequence.currentSequence).padStart(6, '0'))
    .replace('{seq:4}', String(sequence.currentSequence).padStart(4, '0'))
    .replace('{seq}', String(sequence.currentSequence));
  
  return number;
};

numberSequenceSchema.statics.initializeDefaults = async function(companyId, isDemoData = false) {
  const defaults = [
    { documentType: 'Invoice', prefix: 'INV', pattern: 'INV-{year}{month}-{seq:6}' },
    { documentType: 'Payable', prefix: 'PAY', pattern: 'PAY-{year}{month}-{seq:6}' },
    { documentType: 'Expense', prefix: 'EXP', pattern: 'EXP-{year}{month}-{seq:6}' },
    { documentType: 'CreditNote', prefix: 'CRN', pattern: 'CRN-{year}{month}-{seq:6}' },
    { documentType: 'Load', prefix: 'LD', pattern: 'LD-{year}{month}-{seq:6}' },
    { documentType: 'Quote', prefix: 'QTE', pattern: 'QTE-{year}{month}-{seq:6}' },
    { documentType: 'RateAgreement', prefix: 'RAT', pattern: 'RAT-{year}{month}-{seq:6}' },
    { documentType: 'Tender', prefix: 'TND', pattern: 'TND-{year}{month}-{seq:6}' }
  ];
  
  for (const d of defaults) {
    await this.findOneAndUpdate(
      { company: companyId, documentType: d.documentType, isDemoData },
      { $setOnInsert: { prefix: d.prefix, pattern: d.pattern, currentSequence: 0, resetPeriod: 'monthly' } },
      { upsert: true, new: true }
    );
  }
};

module.exports = mongoose.model('NumberSequence', numberSequenceSchema);
