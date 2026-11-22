const mongoose = require('mongoose');

const financialTransactionSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  transactionNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
  type: { type: String, required: true, enum: ['invoice_created', 'invoice_paid', 'invoice_partial_paid', 'invoice_voided', 'credit_note_issued', 'credit_note_applied', 'expense_created', 'expense_paid', 'expense_voided', 'payable_created', 'payable_paid', 'payable_partial_paid', 'payable_voided', 'adjustment_revenue', 'adjustment_expense', 'adjustment_reversal', 'write_off', 'detention_charge', 'accessorial_charge', 'fuel_surcharge', 'payment_received', 'payment_sent', 'refund_issued', 'refund_received', 'opening_balance', 'period_close', 'correction'], index: true },
  status: { type: String, enum: ['posted', 'reversed', 'void'], default: 'posted', index: true },
  currency: { type: String, required: true, trim: true, uppercase: true, default: 'USD', index: true },
  amount: { type: Number, required: true, validate: { validator: Number.isInteger, message: 'amount must be integer (minor units)' } },
  runningBalance: { type: Number, required: true, validate: { validator: Number.isInteger, message: 'runningBalance must be integer (minor units)' } },
  entityType: { type: String, enum: ['Invoice', 'Payable', 'Expense', 'CreditNote', 'Load', 'Customer', 'Carrier', 'Adjustment'], index: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, index: true },
  relatedEntityType: { type: String, enum: ['Invoice', 'Payable', 'Expense', 'CreditNote', 'Load', 'Customer', 'Carrier', 'Adjustment', null], default: null },
  relatedEntityId: { type: mongoose.Schema.Types.ObjectId, default: null },
  paymentMethod: { type: String, enum: ['bank_transfer', 'check', 'cash', 'card', 'ach', 'wire', 'quickpay', 'other', null], default: null },
  paymentReference: { type: String, trim: true, default: null },
  paymentDate: { type: Date, default: null },
  sourceDocumentType: { type: String, enum: ['Invoice', 'Payable', 'Expense', 'CreditNote', 'Load', 'Manual', 'System', null], default: null },
  sourceDocumentId: { type: mongoose.Schema.Types.ObjectId, default: null },
  sourceDocumentNumber: { type: String, trim: true, default: null },
  description: { type: String, required: true, trim: true },
  memo: { type: String, trim: true, default: '' },
  reconciliationStatus: { type: String, enum: ['unreconciled', 'reconciled', 'disputed'], default: 'unreconciled', index: true },
  reconciledAt: { type: Date, default: null },
  reconciledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reconciliationPeriod: { type: String, trim: true, default: null },
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialTransaction', default: null },
  reversalReason: { type: String, trim: true, default: null },
  reversedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  postedAt: { type: Date, default: Date.now, index: true },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

financialTransactionSchema.index({ company: 1, postedAt: -1 });
financialTransactionSchema.index({ company: 1, type: 1, postedAt: -1 });
financialTransactionSchema.index({ company: 1, entityType: 1, entityId: 1 });
financialTransactionSchema.index({ company: 1, reconciliationStatus: 1, postedAt: -1 });
financialTransactionSchema.index({ company: 1, currency: 1, postedAt: -1 });
financialTransactionSchema.index({ company: 1, reconciliationPeriod: 1 });
financialTransactionSchema.index({ company: 1, transactionNumber: 1 }, { unique: true, name: 'company_transactionNumber_unique' });

financialTransactionSchema.statics.toMinorUnits = function(majorAmount, decimals = 2) { return Math.round(Number(majorAmount) * Math.pow(10, decimals)); };
financialTransactionSchema.statics.toMajorUnits = function(minorAmount, decimals = 2) { return Number(minorAmount) / Math.pow(10, decimals); };
financialTransactionSchema.statics.formatAmount = function(minorAmount, currency = 'USD', decimals = 2) { const major = this.toMajorUnits(minorAmount, decimals); return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(major); };
financialTransactionSchema.statics.validatePrecision = function(amount, currency) { const currencyDecimals = { 'USD': 2, 'EUR': 2, 'GBP': 2, 'CAD': 2, 'AUD': 2, 'JPY': 0, 'KRW': 0, 'VND': 0, 'BHD': 3, 'KWD': 3, 'OMR': 3, 'JOD': 3 }; const decimals = currencyDecimals[currency?.toUpperCase()] || 2; const divisor = Math.pow(10, decimals); return Number(amount) % divisor === 0; };

financialTransactionSchema.statics.createTransaction = async function(params) {
  const { company, type, currency = 'USD', amount, runningBalance, entityType, entityId, relatedEntityType, relatedEntityId, paymentMethod, paymentReference, paymentDate, sourceDocumentType, sourceDocumentId, sourceDocumentNumber, description, memo = '', createdBy, isDemoData = false } = params;
  if (!this.validatePrecision(amount, currency)) throw new Error(`Amount ${amount} has invalid precision for currency ${currency}`);
  const transactionNumber = params.transactionNumber || await this.generateTransactionNumber(company, isDemoData);
  const transaction = await this.create({ company, transactionNumber, type, currency, amount, runningBalance, entityType, entityId, relatedEntityType, relatedEntityId, paymentMethod, paymentReference, paymentDate, sourceDocumentType, sourceDocumentId, sourceDocumentNumber, description, memo, createdBy, isDemoData, postedAt: new Date() });
  return transaction;
};

financialTransactionSchema.statics.generateTransactionNumber = async function(companyId, isDemoData = false) {
  const prefix = isDemoData ? 'DEMO' : 'TXN'; const year = new Date().getFullYear(); const month = String(new Date().getMonth() + 1).padStart(2, '0');
  const lastTxn = await this.findOne({ company: companyId, transactionNumber: new RegExp(`^${prefix}-${year}${month}-`) }, {}, { sort: { transactionNumber: -1 } });
  let sequence = 1; if (lastTxn) sequence = parseInt(lastTxn.transactionNumber.split('-').pop(), 10) + 1;
  return `${prefix}-${year}${month}-${String(sequence).padStart(6, '0')}`;
};

financialTransactionSchema.statics.getRunningBalance = async function(companyId, currency = 'USD') {
  const result = await this.aggregate([{ $match: { company: companyId, currency, status: 'posted' } }, { $sort: { postedAt: 1 } }, { $group: { _id: null, balance: { $last: '$runningBalance' } } }]);
  return result.length > 0 ? Number(result[0].balance) : 0;
};

financialTransactionSchema.statics.reverseTransaction = async function(params) {
  const { transactionId, reversedBy, reason } = params;
  const original = await this.findById(transactionId); if (!original) throw new Error('Transaction not found');
  if (original.status !== 'posted') throw new Error(`Cannot reverse transaction with status: ${original.status}`);
  if (original.reversedBy) throw new Error('Transaction already reversed');
  const session = await mongoose.startSession(); session.startTransaction();
  try {
    const currentBalance = await this.getRunningBalance(original.company, original.currency);
    const reversalAmount = -original.amount; const newBalance = currentBalance + reversalAmount;
    const reversal = await this.createTransaction({ company: original.company, type: 'adjustment_reversal', currency: original.currency, amount: reversalAmount, runningBalance: newBalance, entityType: original.entityType, entityId: original.entityId, relatedEntityType: original.entityType, relatedEntityId: original.entityId, description: `Reversal of ${original.transactionNumber}: ${original.description}`, memo: reason || 'Transaction reversed', createdBy: reversedBy, isDemoData: original.isDemoData, sourceDocumentType: 'Manual', sourceDocumentNumber: original.transactionNumber }, { session });
    original.status = 'reversed'; original.reversedBy = reversal._id; original.reversalReason = reason; original.reversedAt = new Date(); await original.save({ session });
    await session.commitTransaction(); return reversal;
  } catch (error) { await session.abortTransaction(); throw error; } finally { await session.endSession(); }
};

financialTransactionSchema.statics.getEntityTransactions = async function(entityType, entityId, companyId) {
  return this.find({ company: companyId, entityType, entityId, status: 'posted' }).sort({ postedAt: 1 }).populate('createdBy', 'name email').populate('reversedBy', 'transactionNumber');
};

financialTransactionSchema.statics.getLedger = async function(params) {
  const { companyId, currency, startDate, endDate, type, entityType, limit = 1000 } = params;
  const match = { company: companyId, status: 'posted' }; if (currency) match.currency = currency; if (type) match.type = type; if (entityType) match.entityType = entityType; if (startDate || endDate) { match.postedAt = {}; if (startDate) match.postedAt.$gte = startDate; if (endDate) match.postedAt.$lte = endDate; }
  return this.find(match).sort({ postedAt: 1, _id: 1 }).limit(limit).populate('createdBy', 'name email').populate('reversedBy', 'transactionNumber');
};

module.exports = mongoose.model('FinancialTransaction', financialTransactionSchema);
