const mongoose = require('mongoose');

const financialAdjustmentSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
  adjustmentNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
  type: { type: String, required: true, enum: ['amount_correction', 'status_change', 'void_correction', 'write_off', 'reversal', 'reclassification', 'rounding_adjustment', 'detention_addition', 'accessorial_addition', 'fuel_surcharge_adjustment', 'currency_correction', 'payment_reallocation'], index: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'applied', 'void'], default: 'pending', index: true },
  documentType: { type: String, required: true, enum: ['Invoice', 'Payable', 'Expense', 'CreditNote'], index: true },
  documentId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  documentNumber: { type: String, required: true, trim: true },
  currency: { type: String, required: true, trim: true, uppercase: true, default: 'USD' },
  originalAmount: { type: Number, required: true, validate: { validator: Number.isInteger, message: 'originalAmount must be integer (minor units)' } },
  adjustedAmount: { type: Number, required: true, validate: { validator: Number.isInteger, message: 'adjustedAmount must be integer (minor units)' } },
  difference: { type: Number, required: true, validate: { validator: Number.isInteger, message: 'difference must be integer (minor units)' } },
  lineItemAdjustments: [{ lineItemId: { type: mongoose.Schema.Types.ObjectId }, field: { type: String, enum: ['quantity', 'unitPrice', 'amount', 'description'] }, oldValue: mongoose.Schema.Types.Mixed, newValue: mongoose.Schema.Types.Mixed }],
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requestedAt: { type: Date, default: Date.now },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: { type: Date },
  rejectionReason: { type: String, trim: true },
  appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  appliedAt: { type: Date },
  appliedTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialTransaction' },
  reason: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  supportingDocuments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Document' }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

financialAdjustmentSchema.index({ company: 1, documentType: 1, documentId: 1 });
financialAdjustmentSchema.index({ company: 1, status: 1, requestedAt: -1 });
financialAdjustmentSchema.index({ company: 1, requestedBy: 1 });
financialAdjustmentSchema.index({ company: 1, adjustmentNumber: 1 }, { unique: true, name: 'company_adjustmentNumber_unique' });

financialAdjustmentSchema.statics.generateAdjustmentNumber = async function(companyId, isDemoData = false) { const prefix = isDemoData ? 'DEMO-ADJ' : 'ADJ'; const year = new Date().getFullYear(); const month = String(new Date().getMonth() + 1).padStart(2, '0'); const lastAdj = await this.findOne({ company: companyId, adjustmentNumber: new RegExp(`^${prefix}-${year}${month}-`) }, {}, { sort: { adjustmentNumber: -1 } }); let sequence = 1; if (lastAdj) sequence = parseInt(lastAdj.adjustmentNumber.split('-').pop(), 10) + 1; return `${prefix}-${year}${month}-${String(sequence).padStart(6, '0')}`; };

financialAdjustmentSchema.methods.apply = async function(userId) { if (this.status !== 'approved') throw new Error('Only approved adjustments can be applied'); const session = await mongoose.startSession(); session.startTransaction(); try { const Model = mongoose.model(this.documentType); const doc = await Model.findById(this.documentId).session(session); if (!doc) throw new Error('Document not found'); doc.amount = this.adjustedAmount; doc.updatedBy = userId; await doc.save({ session }); const FinancialTransaction = mongoose.model('FinancialTransaction'); const currentBalance = await FinancialTransaction.getRunningBalance(this.company, this.currency); const newBalance = currentBalance + this.difference; const transaction = await FinancialTransaction.createTransaction({ company: this.company, type: this.type === 'reversal' ? 'adjustment_reversal' : this.difference > 0 ? 'adjustment_revenue' : 'adjustment_expense', currency: this.currency, amount: this.difference, runningBalance: newBalance, entityType: this.documentType, entityId: this.documentId, description: `Adjustment ${this.adjustmentNumber}: ${this.reason}`, memo: this.description || '', createdBy: userId, isDemoData: this.isDemoData, sourceDocumentType: this.documentType, sourceDocumentId: this.documentId, sourceDocumentNumber: this.documentNumber }, { session }); this.status = 'applied'; this.appliedBy = userId; this.appliedAt = new Date(); this.appliedTransactionId = transaction._id; await this.save({ session }); await session.commitTransaction(); return { document: doc, transaction }; } catch (error) { await session.abortTransaction(); throw error; } finally { await session.endSession(); } };

module.exports = mongoose.model('FinancialAdjustment', financialAdjustmentSchema);
