const mongoose = require('mongoose');

/**
 * Transaction Boundary Helper - Manages MongoDB transactions
 * 
 * Provides consistent transaction handling across services.
 * Ensures all-or-nothing operations for financial data integrity.
 */

/**
 * Execute a function within a MongoDB transaction
 * @param {Function} callback - Async function to execute in transaction
 * @param {Object} options - Transaction options
 * @returns {Promise<any>} Callback result
 */
async function withTransaction(callback, options = {}) {
  const { maxCommitTimeMS = 30000, readPreference = 'primary' } = options;
  
  const session = await mongoose.startSession();
  session.startTransaction({ readPreference, maxCommitTimeMS });
  
  try {
    const result = await callback(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

/**
 * Execute multiple operations in a single transaction
 * @param {Array<Function>} operations - Array of async functions (each receives session)
 * @returns {Promise<Array>} Array of results
 */
async function withTransactionBatch(operations) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const results = [];
    for (const op of operations) {
      results.push(await op(session));
    }
    await session.commitTransaction();
    return results;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

/**
 * Wrapper for mongoose model operations with session
 * @param {Model} Model - Mongoose model
 * @param {Object} session - MongoDB session
 * @returns {Object} Model with session-bound methods
 */
function withSession(Model, session) {
  return {
    create: (docs, options = {}) => Model.create(docs, { ...options, session }),
    findById: (id, options = {}) => Model.findById(id, options).session(session),
    findByIdAndUpdate: (id, update, options = {}) => Model.findByIdAndUpdate(id, update, { ...options, session, new: true }),
    findByIdAndDelete: (id, options = {}) => Model.findByIdAndDelete(id, { ...options, session }),
    findOne: (filter, options = {}) => Model.findOne(filter, options).session(session),
    findOneAndUpdate: (filter, update, options = {}) => Model.findOneAndUpdate(filter, update, { ...options, session, new: true }),
    find: (filter, options = {}) => Model.find(filter, options).session(session),
    updateOne: (filter, update, options = {}) => Model.updateOne(filter, update, { ...options, session }),
    updateMany: (filter, update, options = {}) => Model.updateMany(filter, update, { ...options, session }),
    deleteOne: (filter, options = {}) => Model.deleteOne(filter, { ...options, session }),
    deleteMany: (filter, options = {}) => Model.deleteMany(filter, { ...options, session }),
    aggregate: (pipeline, options = {}) => Model.aggregate(pipeline, { ...options, session }),
    countDocuments: (filter, options = {}) => Model.countDocuments(filter, { ...options, session }),
    save: (doc) => doc.save({ session })
  };
}

/**
 * Common financial transaction patterns
 */
const FinancialPatterns = {
  /**
   * Create invoice + financial transaction atomically
   */
  async createInvoiceWithTransaction(invoiceData, userId, session) {
    const Invoice = mongoose.model('Invoice');
    const FinancialTransaction = mongoose.model('FinancialTransaction');
    const NumberSequence = mongoose.model('NumberSequence');
    
    const companyId = invoiceData.company;
    
    // Generate invoice number
    const invoiceNumber = await NumberSequence.getNextNumber(companyId, 'Invoice', invoiceData.isDemoData);
    
    // Calculate amounts in minor units
    const lineItems = invoiceData.lineItems || [];
    let amount = 0;
    for (const item of lineItems) {
      const qty = Number(item.quantity || 0);
      const price = Number(item.unitPrice || 0);
      item.amount = qty * price;
      amount += item.amount;
    }
    
    // Create invoice
    const invoice = await Invoice.create([{ ...invoiceData, invoiceNumber, amount }], { session });
    
    // Create financial transaction
    const currentBalance = await FinancialTransaction.getRunningBalance(companyId, invoiceData.currency);
    const newBalance = currentBalance + amount;
    
    const transaction = await FinancialTransaction.createTransaction({
      company: companyId,
      type: 'invoice_created',
      currency: invoiceData.currency,
      amount,
      runningBalance: newBalance,
      entityType: 'Invoice',
      entityId: invoice[0]._id,
      description: `Invoice ${invoiceNumber} created`,
      sourceDocumentType: 'Invoice',
      sourceDocumentId: invoice[0]._id,
      sourceDocumentNumber: invoiceNumber,
      createdBy: userId,
      isDemoData: invoiceData.isDemoData
    }, { session });
    
    return { invoice: invoice[0], transaction };
  },

  /**
   * Record payment on invoice + financial transaction atomically
   */
  async recordInvoicePayment(invoiceId, paymentData, userId, session) {
    const Invoice = mongoose.model('Invoice');
    const FinancialTransaction = mongoose.model('FinancialTransaction');
    
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) throw new Error('Invoice not found');
    
    const paymentAmount = paymentData.amount; // in minor units
    const companyId = invoice.company;
    
    // Update invoice
    invoice.paidAmount = Math.min((invoice.paidAmount || 0) + paymentAmount, invoice.amount);
    if (invoice.paidAmount >= invoice.amount) invoice.status = 'paid';
    else if (invoice.paidAmount > 0) invoice.status = 'partial';
    invoice.updatedBy = userId;
    await invoice.save({ session });
    
    // Create financial transaction
    const currentBalance = await FinancialTransaction.getRunningBalance(companyId, invoice.currency);
    const newBalance = currentBalance + paymentAmount;
    
    const transaction = await FinancialTransaction.createTransaction({
      company: companyId,
      type: invoice.paidAmount >= invoice.amount ? 'invoice_paid' : 'invoice_partial_paid',
      currency: invoice.currency,
      amount: paymentAmount,
      runningBalance: newBalance,
      entityType: 'Invoice',
      entityId: invoice._id,
      paymentMethod: paymentData.paymentMethod,
      paymentReference: paymentData.reference,
      paymentDate: paymentData.date || new Date(),
      description: `Payment received for invoice ${invoice.invoiceNumber}`,
      sourceDocumentType: 'Invoice',
      sourceDocumentId: invoice._id,
      sourceDocumentNumber: invoice.invoiceNumber,
      createdBy: userId,
      isDemoData: invoice.isDemoData
    }, { session });
    
    return { invoice, transaction };
  },

  /**
   * Create payable + financial transaction atomically
   */
  async createPayableWithTransaction(payableData, userId, session) {
    const Payable = mongoose.model('Payable');
    const FinancialTransaction = mongoose.model('FinancialTransaction');
    const NumberSequence = mongoose.model('NumberSequence');
    
    const companyId = payableData.company;
    const payableNumber = await NumberSequence.getNextNumber(companyId, 'Payable', payableData.isDemoData);
    
    const lineItems = payableData.lineItems || [];
    let amount = 0;
    for (const item of lineItems) {
      const qty = Number(item.quantity || 0);
      const price = Number(item.unitPrice || 0);
      item.amount = qty * price;
      amount += item.amount;
    }
    
    const payable = await Payable.create([{ ...payableData, payableNumber, amount }], { session });
    
    const currentBalance = await FinancialTransaction.getRunningBalance(companyId, payableData.currency);
    const newBalance = currentBalance - amount; // Payable is a liability (negative)
    
    const transaction = await FinancialTransaction.createTransaction({
      company: companyId,
      type: 'payable_created',
      currency: payableData.currency,
      amount: -amount, // Negative for payable
      runningBalance: newBalance,
      entityType: 'Payable',
      entityId: payable[0]._id,
      description: `Payable ${payableNumber} created`,
      sourceDocumentType: 'Payable',
      sourceDocumentId: payable[0]._id,
      sourceDocumentNumber: payableNumber,
      createdBy: userId,
      isDemoData: payableData.isDemoData
    }, { session });
    
    return { payable: payable[0], transaction };
  },

  /**
   * Record payment on payable + financial transaction atomically
   */
  async recordPayablePayment(payableId, paymentData, userId, session) {
    const Payable = mongoose.model('Payable');
    const FinancialTransaction = mongoose.model('FinancialTransaction');
    
    const payable = await Payable.findById(payableId).session(session);
    if (!payable) throw new Error('Payable not found');
    
    const paymentAmount = paymentData.amount;
    const companyId = payable.company;
    
    payable.paidAmount = Math.min((payable.paidAmount || 0) + paymentAmount, payable.amount);
    if (payable.paidAmount >= payable.amount) payable.status = 'paid';
    payable.updatedBy = userId;
    await payable.save({ session });
    
    const currentBalance = await FinancialTransaction.getRunningBalance(companyId, payable.currency);
    const newBalance = currentBalance + paymentAmount; // Positive - reducing liability
    
    const transaction = await FinancialTransaction.createTransaction({
      company: companyId,
      type: payable.paidAmount >= payable.amount ? 'payable_paid' : 'payable_partial_paid',
      currency: payable.currency,
      amount: paymentAmount,
      runningBalance: newBalance,
      entityType: 'Payable',
      entityId: payable._id,
      paymentMethod: paymentData.paymentMethod,
      paymentReference: paymentData.reference,
      paymentDate: paymentData.date || new Date(),
      description: `Payment made for payable ${payable.payableNumber}`,
      sourceDocumentType: 'Payable',
      sourceDocumentId: payable._id,
      sourceDocumentNumber: payable.payableNumber,
      createdBy: userId,
      isDemoData: payable.isDemoData
    }, { session });
    
    return { payable, transaction };
  }
};

module.exports = {
  withTransaction,
  withTransactionBatch,
  withSession,
  FinancialPatterns
};
