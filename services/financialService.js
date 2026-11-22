const mongoose = require('mongoose');
const { withTransaction, FinancialPatterns } = require('./transactionHelper');
const FinancialTransaction = require('../models/FinancialTransaction');
const FinancialAdjustment = require('../models/FinancialAdjustment');
const NumberSequence = require('../models/NumberSequence');
const { recordAuditEvent } = require('./auditService');

/**
 * Financial Service - High-level financial operations
 * 
 * Provides unified API for all financial operations with proper
 * transaction boundaries and audit logging.
 */

/**
 * Initialize number sequences for a company
 * @param {ObjectId} companyId - Company ID
 * @param {boolean} isDemoData - Whether demo data
 * @returns {Promise<void>}
 */
async function initializeCompanySequences(companyId, isDemoData = false) {
  await NumberSequence.initializeDefaults(companyId, isDemoData);
}

/**
 * Create invoice with automatic numbering and transaction
 * @param {Object} params - Invoice parameters
 * @returns {Promise<Object>} Created invoice and transaction
 */
async function createInvoice(params) {
  return withTransaction(async (session) => {
    const { company, customer, lineItems, currency = 'USD', dueDate, notes, createdBy, isDemoData = false, linkedLoads = [] } = params;
    
    const invoiceNumber = await NumberSequence.getNextNumber(company, 'Invoice', isDemoData);
    
    // Calculate amounts in minor units
    let amount = 0;
    for (const item of lineItems || []) {
      const qty = Number(item.quantity || 0);
      const price = FinancialTransaction.toMinorUnits(item.unitPrice, 2);
      item.amount = qty * price;
      amount += item.amount;
    }
    
    const Invoice = mongoose.model('Invoice');
    const invoice = await Invoice.create([{
      company, customer, invoiceNumber, currency,
      issueDate: new Date(), dueDate, lineItems,
      amount, paidAmount: 0, status: 'draft',
      notes, linkedLoads, createdBy, updatedBy: createdBy, isDemoData
    }], { session });
    
    // Create financial transaction
    const currentBalance = await FinancialTransaction.getRunningBalance(company, currency);
    const newBalance = currentBalance + amount;
    
    const transaction = await FinancialTransaction.createTransaction({
      company, type: 'invoice_created', currency, amount,
      runningBalance: newBalance, entityType: 'Invoice', entityId: invoice[0]._id,
      description: `Invoice ${invoiceNumber} created`,
      sourceDocumentType: 'Invoice', sourceDocumentId: invoice[0]._id, sourceDocumentNumber: invoiceNumber,
      createdBy, isDemoData
    }, { session });
    
    await recordAuditEvent({ action: 'INVOICE_CREATED', entityType: 'Invoice', entityId: invoice[0]._id, companyId: company, actor: { id: createdBy }, summary: `Invoice ${invoiceNumber} created`, severity: 'info', metadata: { amount, currency } }, { session });
    
    return { invoice: invoice[0], transaction };
  });
}

/**
 * Record payment on invoice
 * @param {Object} params - Payment parameters
 * @returns {Promise<Object>} Updated invoice and transaction
 */
async function recordInvoicePayment(params) {
  return withTransaction(async (session) => {
    const { invoiceId, amount, paymentMethod, reference, date, userId } = params;
    
    const Invoice = mongoose.model('Invoice');
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) throw new Error('Invoice not found');
    
    const paymentAmount = FinancialTransaction.toMinorUnits(amount, 2);
    const newPaidAmount = Math.min((invoice.paidAmount || 0) + paymentAmount, invoice.amount);
    
    const previousStatus = invoice.status;
    invoice.paidAmount = newPaidAmount;
    if (newPaidAmount >= invoice.amount) invoice.status = 'paid';
    else if (newPaidAmount > 0) invoice.status = 'partial';
    invoice.updatedBy = userId;
    await invoice.save({ session });
    
    const currentBalance = await FinancialTransaction.getRunningBalance(invoice.company, invoice.currency);
    const newBalance = currentBalance + paymentAmount;
    
    const transaction = await FinancialTransaction.createTransaction({
      company: invoice.company, type: newPaidAmount >= invoice.amount ? 'invoice_paid' : 'invoice_partial_paid',
      currency: invoice.currency, amount: paymentAmount, runningBalance: newBalance,
      entityType: 'Invoice', entityId: invoice._id,
      paymentMethod, paymentReference: reference, paymentDate: date || new Date(),
      description: `Payment received for invoice ${invoice.invoiceNumber}`,
      sourceDocumentType: 'Invoice', sourceDocumentId: invoice._id, sourceDocumentNumber: invoice.invoiceNumber,
      createdBy: userId, isDemoData: invoice.isDemoData
    }, { session });
    
    await recordAuditEvent({ action: 'INVOICE_PAYMENT_RECORDED', entityType: 'Invoice', entityId: invoice._id, companyId: invoice.company, actor: { id: userId }, summary: `Payment recorded for invoice ${invoice.invoiceNumber}`, severity: 'info', metadata: { amount: paymentAmount, previousStatus, newStatus: invoice.status } }, { session });
    
    return { invoice, transaction };
  });
}

/**
 * Create payable with automatic numbering and transaction
 * @param {Object} params - Payable parameters
 * @returns {Promise<Object>} Created payable and transaction
 */
async function createPayable(params) {
  return withTransaction(async (session) => {
    const { company, carrier, lineItems, currency = 'USD', dueDate, notes, createdBy, isDemoData = false, linkedLoads = [] } = params;
    
    const payableNumber = await NumberSequence.getNextNumber(company, 'Payable', isDemoData);
    
    let amount = 0;
    for (const item of lineItems || []) {
      const qty = Number(item.quantity || 0);
      const price = FinancialTransaction.toMinorUnits(item.unitPrice, 2);
      item.amount = qty * price;
      amount += item.amount;
    }
    
    const Payable = mongoose.model('Payable');
    const payable = await Payable.create([{
      company, carrier, payableNumber, currency,
      issueDate: new Date(), dueDate, lineItems,
      amount, paidAmount: 0, status: 'draft',
      notes, linkedLoads, createdBy, updatedBy: createdBy, isDemoData
    }], { session });
    
    const currentBalance = await FinancialTransaction.getRunningBalance(company, currency);
    const newBalance = currentBalance - amount;
    
    const transaction = await FinancialTransaction.createTransaction({
      company, type: 'payable_created', currency, amount: -amount, runningBalance: newBalance,
      entityType: 'Payable', entityId: payable[0]._id,
      description: `Payable ${payableNumber} created`,
      sourceDocumentType: 'Payable', sourceDocumentId: payable[0]._id, sourceDocumentNumber: payableNumber,
      createdBy, isDemoData
    }, { session });
    
    await recordAuditEvent({ action: 'PAYABLE_CREATED', entityType: 'Payable', entityId: payable[0]._id, companyId: company, actor: { id: createdBy }, summary: `Payable ${payableNumber} created`, severity: 'info', metadata: { amount, currency } }, { session });
    
    return { payable: payable[0], transaction };
  });
}

/**
 * Record payment on payable
 * @param {Object} params - Payment parameters
 * @returns {Promise<Object>} Updated payable and transaction
 */
async function recordPayablePayment(params) {
  return withTransaction(async (session) => {
    const { payableId, amount, paymentMethod, reference, date, userId } = params;
    
    const Payable = mongoose.model('Payable');
    const payable = await Payable.findById(payableId).session(session);
    if (!payable) throw new Error('Payable not found');
    
    const paymentAmount = FinancialTransaction.toMinorUnits(amount, 2);
    const newPaidAmount = Math.min((payable.paidAmount || 0) + paymentAmount, payable.amount);
    
    const previousStatus = payable.status;
    payable.paidAmount = newPaidAmount;
    if (newPaidAmount >= payable.amount) payable.status = 'paid';
    payable.updatedBy = userId;
    await payable.save({ session });
    
    const currentBalance = await FinancialTransaction.getRunningBalance(payable.company, payable.currency);
    const newBalance = currentBalance + paymentAmount;
    
    const transaction = await FinancialTransaction.createTransaction({
      company: payable.company, type: newPaidAmount >= payable.amount ? 'payable_paid' : 'payable_partial_paid',
      currency: payable.currency, amount: paymentAmount, runningBalance: newBalance,
      entityType: 'Payable', entityId: payable._id,
      paymentMethod, paymentReference: reference, paymentDate: date || new Date(),
      description: `Payment made for payable ${payable.payableNumber}`,
      sourceDocumentType: 'Payable', sourceDocumentId: payable._id, sourceDocumentNumber: payable.payableNumber,
      createdBy: userId, isDemoData: payable.isDemoData
    }, { session });
    
    await recordAuditEvent({ action: 'PAYABLE_PAYMENT_RECORDED', entityType: 'Payable', entityId: payable._id, companyId: payable.company, actor: { id: userId }, summary: `Payment recorded for payable ${payable.payableNumber}`, severity: 'info', metadata: { amount: paymentAmount, previousStatus, newStatus: payable.status } }, { session });
    
    return { payable, transaction };
  });
}

/**
 * Create expense with automatic numbering and transaction
 * @param {Object} params - Expense parameters
 * @returns {Promise<Object>} Created expense and transaction
 */
async function createExpense(params) {
  return withTransaction(async (session) => {
    const { company, lineItems, currency = 'USD', dueDate, notes, createdBy, isDemoData = false, linkedLoads = [], carrierId } = params;
    
    const expenseNumber = await NumberSequence.getNextNumber(company, 'Expense', isDemoData);
    
    let amount = 0;
    for (const item of lineItems || []) {
      const qty = Number(item.quantity || 0);
      const price = FinancialTransaction.toMinorUnits(item.unitPrice, 2);
      item.amount = qty * price;
      amount += item.amount;
    }
    
    const Expense = mongoose.model('Expense');
    const expense = await Expense.create([{
      company, expenseNumber, currency, issueDate: new Date(), dueDate, lineItems,
      amount, paidAmount: 0, status: 'draft', notes, linkedLoads, carrierId,
      createdBy, updatedBy: createdBy, isDemoData
    }], { session });
    
    const currentBalance = await FinancialTransaction.getRunningBalance(company, currency);
    const newBalance = currentBalance - amount;
    
    const transaction = await FinancialTransaction.createTransaction({
      company, type: 'expense_created', currency, amount: -amount, runningBalance: newBalance,
      entityType: 'Expense', entityId: expense[0]._id,
      description: `Expense ${expenseNumber} created`,
      sourceDocumentType: 'Expense', sourceDocumentId: expense[0]._id, sourceDocumentNumber: expenseNumber,
      createdBy, isDemoData
    }, { session });
    
    await recordAuditEvent({ action: 'EXPENSE_CREATED', entityType: 'Expense', entityId: expense[0]._id, companyId: company, actor: { id: createdBy }, summary: `Expense ${expenseNumber} created`, severity: 'info', metadata: { amount, currency } }, { session });
    
    return { expense: expense[0], transaction };
  });
}

/**
 * Create credit note with automatic numbering
 * @param {Object} params - Credit note parameters
 * @returns {Promise<Object>} Created credit note and transaction
 */
async function createCreditNote(params) {
  return withTransaction(async (session) => {
    const { company, customer, originalInvoice, lineItems, currency = 'USD', reason, notes, createdBy, isDemoData = false, linkedLoads = [] } = params;
    
    const creditNoteNumber = await NumberSequence.getNextNumber(company, 'CreditNote', isDemoData);
    
    let amount = 0;
    for (const item of lineItems || []) {
      const qty = Number(item.quantity || 0);
      const price = FinancialTransaction.toMinorUnits(item.unitPrice, 2);
      item.amount = qty * price;
      amount += item.amount;
    }
    
    const CreditNote = mongoose.model('CreditNote');
    const creditNote = await CreditNote.create([{
      company, customer, originalInvoice, creditNoteNumber, currency,
      issueDate: new Date(), reason, lineItems, amount, appliedAmount: 0, status: 'draft',
      notes, linkedLoads, createdBy, updatedBy: createdBy, isDemoData
    }], { session });
    
    const currentBalance = await FinancialTransaction.getRunningBalance(company, currency);
    const newBalance = currentBalance - amount; // Credit note reduces AR
    
    const transaction = await FinancialTransaction.createTransaction({
      company, type: 'credit_note_issued', currency, amount: -amount, runningBalance: newBalance,
      entityType: 'CreditNote', entityId: creditNote[0]._id,
      description: `Credit note ${creditNoteNumber} issued`,
      sourceDocumentType: 'CreditNote', sourceDocumentId: creditNote[0]._id, sourceDocumentNumber: creditNoteNumber,
      createdBy, isDemoData
    }, { session });
    
    await recordAuditEvent({ action: 'CREDIT_NOTE_ISSUED', entityType: 'CreditNote', entityId: creditNote[0]._id, companyId: company, actor: { id: createdBy }, summary: `Credit note ${creditNoteNumber} issued`, severity: 'info', metadata: { amount, currency } }, { session });
    
    return { creditNote: creditNote[0], transaction };
  });
}

/**
 * Apply credit note to invoice
 * @param {Object} params - Application parameters
 * @returns {Promise<Object>} Updated credit note, invoice, and transaction
 */
async function applyCreditNote(params) {
  return withTransaction(async (session) => {
    const { creditNoteId, invoiceId, amount, userId } = params;
    
    const CreditNote = mongoose.model('CreditNote');
    const Invoice = mongoose.model('Invoice');
    
    const creditNote = await CreditNote.findById(creditNoteId).session(session);
    const invoice = await Invoice.findById(invoiceId).session(session);
    
    if (!creditNote || !invoice) throw new Error('Credit note or invoice not found');
    if (creditNote.status === 'void') throw new Error('Credit note is void');
    if (invoice.status === 'void') throw new Error('Invoice is void');
    if (String(creditNote.company) !== String(invoice.company)) throw new Error('Company mismatch');
    if (String(creditNote.customer) !== String(invoice.customer)) throw new Error('Customer mismatch');
    
    const applyAmount = FinancialTransaction.toMinorUnits(amount, 2);
    const maxApply = Math.min(creditNote.balanceDue(), invoice.balanceDue());
    if (applyAmount > maxApply) throw new Error('Application amount exceeds available balance');
    
    creditNote.appliedAmount = (creditNote.appliedAmount || 0) + applyAmount;
    if (creditNote.appliedAmount >= creditNote.amount) creditNote.status = 'applied';
    creditNote.updatedBy = userId;
    await creditNote.save({ session });
    
    invoice.paidAmount = (invoice.paidAmount || 0) + applyAmount;
    if (invoice.paidAmount >= invoice.amount) invoice.status = 'paid';
    invoice.updatedBy = userId;
    await invoice.save({ session });
    
    const currentBalance = await FinancialTransaction.getRunningBalance(creditNote.company, creditNote.currency);
    const newBalance = currentBalance + applyAmount; // Applying credit increases AR (reduces credit)
    
    const transaction = await FinancialTransaction.createTransaction({
      company: creditNote.company, type: 'credit_note_applied', currency: creditNote.currency, amount: applyAmount,
      runningBalance: newBalance, entityType: 'CreditNote', entityId: creditNote._id,
      relatedEntityType: 'Invoice', relatedEntityId: invoice._id,
      description: `Credit note ${creditNote.creditNoteNumber} applied to invoice ${invoice.invoiceNumber}`,
      sourceDocumentType: 'CreditNote', sourceDocumentId: creditNote._id, sourceDocumentNumber: creditNote.creditNoteNumber,
      createdBy: userId, isDemoData: creditNote.isDemoData
    }, { session });
    
    await recordAuditEvent({ action: 'CREDIT_NOTE_APPLIED', entityType: 'CreditNote', entityId: creditNote._id, companyId: creditNote.company, actor: { id: userId }, summary: `Credit note ${creditNote.creditNoteNumber} applied to invoice ${invoice.invoiceNumber}`, severity: 'info', metadata: { amount: applyAmount } }, { session });
    
    return { creditNote, invoice, transaction };
  });
}

/**
 * Create financial adjustment request
 * @param {Object} params - Adjustment parameters
 * @returns {Promise<Object>} Created adjustment
 */
async function createAdjustment(params) {
  const { company, documentType, documentId, documentNumber, currency, originalAmount, adjustedAmount, type, reason, description, requestedBy, supportingDocuments = [], isDemoData = false } = params;
  
  const difference = adjustedAmount - originalAmount;
  
  const adjustmentNumber = await FinancialAdjustment.generateAdjustmentNumber(company, isDemoData);
  
  const adjustment = await FinancialAdjustment.create({
    company, adjustmentNumber, type, status: 'pending',
    documentType, documentId, documentNumber, currency,
    originalAmount: mongoose.Types.Long.fromNumber(originalAmount),
    adjustedAmount: mongoose.Types.Long.fromNumber(adjustedAmount),
    difference: mongoose.Types.Long.fromNumber(difference),
    reason, description, requestedBy, supportingDocuments, createdBy: requestedBy, isDemoData
  });
  
  await recordAuditEvent({ action: 'FINANCIAL_ADJUSTMENT_REQUESTED', entityType: 'FinancialAdjustment', entityId: adjustment._id, companyId: company, actor: { id: requestedBy }, summary: `Financial adjustment ${adjustmentNumber} requested for ${documentType} ${documentNumber}`, severity: 'info', metadata: { originalAmount, adjustedAmount, difference, type } });
  
  return adjustment;
}

/**
 * Approve financial adjustment
 * @param {Object} params - Approval parameters
 * @returns {Promise<Object>} Approved adjustment
 */
async function approveAdjustment(params) {
  const { adjustmentId, approvedBy } = params;
  
  const adjustment = await FinancialAdjustment.findById(adjustmentId);
  if (!adjustment) throw new Error('Adjustment not found');
  if (adjustment.status !== 'pending') throw new Error('Only pending adjustments can be approved');
  
  adjustment.status = 'approved';
  adjustment.approvedBy = approvedBy;
  adjustment.approvedAt = new Date();
  await adjustment.save();
  
  await recordAuditEvent({ action: 'FINANCIAL_ADJUSTMENT_APPROVED', entityType: 'FinancialAdjustment', entityId: adjustment._id, companyId: adjustment.company, actor: { id: approvedBy }, summary: `Financial adjustment ${adjustment.adjustmentNumber} approved`, severity: 'info' });
  
  return adjustment;
}

/**
 * Apply approved adjustment
 * @param {Object} params - Apply parameters
 * @returns {Promise<Object>} Applied adjustment with document and transaction
 */
async function applyAdjustment(params) {
  const { adjustmentId, userId } = params;
  
  const adjustment = await FinancialAdjustment.findById(adjustmentId);
  if (!adjustment) throw new Error('Adjustment not found');
  if (adjustment.status !== 'approved') throw new Error('Only approved adjustments can be applied');
  
  return await adjustment.apply(userId);
}

/**
 * Get ledger for a company
 * @param {Object} params - Ledger parameters
 * @returns {Promise<Array>} Ledger entries
 */
async function getLedger(params) {
  return FinancialTransaction.getLedger(params);
}

/**
 * Get account balance for a company/currency
 * @param {ObjectId} companyId - Company ID
 * @param {string} currency - Currency code
 * @returns {Promise<number>} Balance in minor units
 */
async function getBalance(companyId, currency = 'USD') {
  return FinancialTransaction.getRunningBalance(companyId, currency);
}

/**
 * Reconcile transactions for a period
 * @param {Object} params - Reconciliation parameters
 * @returns {Promise<Object>} Reconciliation result
 */
async function reconcilePeriod(params) {
  const { companyId, currency, period, userId } = params; // period format: 'YYYY-MM'
  
  const startDate = new Date(period + '-01');
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + 1);
  
  const transactions = await FinancialTransaction.find({
    company: companyId, currency, status: 'posted',
    postedAt: { $gte: startDate, $lt: endDate }
  }).sort({ postedAt: 1 });
  
  let reconciledCount = 0;
  for (const txn of transactions) {
    if (txn.reconciliationStatus === 'unreconciled') {
      txn.reconciliationStatus = 'reconciled';
      txn.reconciledAt = new Date();
      txn.reconciledBy = userId;
      txn.reconciliationPeriod = period;
      await txn.save();
      reconciledCount++;
    }
  }
  
  await recordAuditEvent({ action: 'PERIOD_RECONCILED', entityType: 'FinancialTransaction', entityId: null, companyId: companyId, actor: { id: userId }, summary: `Period ${period} reconciled (${reconciledCount} transactions)`, severity: 'info', metadata: { currency, reconciledCount } });
  
  return { period, currency, reconciledCount, totalTransactions: transactions.length };
}

/**
 * Get financial summary for a company
 * @param {ObjectId} companyId - Company ID
 * @param {Object} options - Options
 * @returns {Promise<Object>} Financial summary
 */
async function getFinancialSummary(companyId, options = {}) {
  const { startDate, endDate, currency = 'USD' } = options;
  
  const match = { company: companyId, status: 'posted', currency };
  if (startDate || endDate) {
    match.postedAt = {};
    if (startDate) match.postedAt.$gte = startDate;
    if (endDate) match.postedAt.$lte = endDate;
  }
  
  const pipeline = [
    { $match: match },
    { $group: {
      _id: '$type',
      totalAmount: { $sum: { $toDouble: '$amount' } },
      count: { $sum: 1 }
    }},
    { $sort: { totalAmount: -1 } }
  ];
  
  const byType = await FinancialTransaction.aggregate(pipeline);
  const balance = await getBalance(companyId, currency);
  
  const revenueTypes = ['invoice_created', 'invoice_paid', 'invoice_partial_paid', 'credit_note_applied', 'payment_received', 'refund_received', 'adjustment_revenue', 'detention_charge', 'accessorial_charge', 'fuel_surcharge'];
  const expenseTypes = ['payable_created', 'payable_paid', 'payable_partial_paid', 'expense_created', 'expense_paid', 'credit_note_issued', 'payment_sent', 'refund_issued', 'adjustment_expense', 'write_off'];
  
  let revenue = 0, expenses = 0;
  for (const item of byType) {
    if (revenueTypes.includes(item._id)) revenue += item.totalAmount;
    else if (expenseTypes.includes(item._id)) expenses += Math.abs(item.totalAmount);
  }
  
  return {
    currency,
    balance: FinancialTransaction.formatAmount(balance, currency),
    balanceMinor: balance,
    revenue: FinancialTransaction.formatAmount(revenue, currency),
    revenueMinor: revenue,
    expenses: FinancialTransaction.formatAmount(expenses, currency),
    expensesMinor: expenses,
    netIncome: FinancialTransaction.formatAmount(revenue - expenses, currency),
    netIncomeMinor: revenue - expenses,
    transactionCount: byType.reduce((sum, item) => sum + item.count, 0),
    byType: byType.map(item => ({
      type: item._id,
      amount: FinancialTransaction.formatAmount(item.totalAmount, currency),
      amountMinor: item.totalAmount,
      count: item.count
    }))
  };
}

module.exports = {
  initializeCompanySequences,
  createInvoice,
  recordInvoicePayment,
  createPayable,
  recordPayablePayment,
  createExpense,
  createCreditNote,
  applyCreditNote,
  createAdjustment,
  approveAdjustment,
  applyAdjustment,
  getLedger,
  getBalance,
  reconcilePeriod,
  getFinancialSummary
};
