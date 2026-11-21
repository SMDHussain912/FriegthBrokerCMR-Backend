const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Payable = require('../models/Payable');
const Expense = require('../models/Expense');
const CreditNote = require('../models/CreditNote');
const { recordAuditEvent } = require('./auditService');

class FinanceExportError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const EXPORT_READ_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer', 'platform_admin', 'platform_support']);

const EXPORTABLE_ENTITIES = new Set(['invoices', 'payables', 'expenses', 'credit-notes']);

const MODEL_MAP = {
  invoices: Invoice,
  payables: Payable,
  expenses: Expense,
  'credit-notes': CreditNote,
};

const CSV_HEADER_MAP = {
  invoices: ['creditNoteNumber','customer','status','currency','amount','paidAmount','balanceDue','issueDate','dueDate','notes'],
  payables: ['payableNumber','carrier','status','currency','amount','paidAmount','balanceDue','issueDate','dueDate','notes'],
  expenses: ['expenseNumber','carrierId','status','currency','amount','paidAmount','balanceDue','issueDate','dueDate','notes'],
  'credit-notes': ['creditNoteNumber','customer','originalInvoice','status','currency','amount','appliedAmount','balanceDue','issueDate','dueDate','reason','notes'],
};

function assertCompany(req, { allowDemo = false } = {}) {
  const explicitDemo = req.headers && req.headers['x-demo-mode'] === 'true';
  const queryDemo = req.query && req.query.demo === 'true';
  if (req.isDemoMode || explicitDemo || queryDemo) {
    if (!allowDemo || explicitDemo || queryDemo) {
      throw new FinanceExportError(403, 'DEMO_NOT_ALLOWED', 'This operation is not available in demo mode.');
    }
    return;
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new FinanceExportError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertRole(req, allowed, action) {
  if (req.isDemoMode) return;
  const role = req.membership && req.membership.role;
  if (!role || !allowed.has(role)) {
    throw new FinanceExportError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action}.`);
  }
}

function tenantFilter(req) {
  return req.isDemoMode ? { isDemoData: true } : { company: req.companyId, isDemoData: false };
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function exportFinancials(req, entityType, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, EXPORT_READ_ROLES, 'export financials');
  if (!EXPORTABLE_ENTITIES.has(entityType)) {
    throw new FinanceExportError(400, 'INVALID_ENTITY', `Entity must be one of: ${Array.from(EXPORTABLE_ENTITIES).join(', ')}`);
  }

  const Model = MODEL_MAP[entityType];
  const filter = tenantFilter(req);
  if (query.customer && mongoose.Types.ObjectId.isValid(String(query.customer))) filter.customer = query.customer;
  if (query.carrierId && mongoose.Types.ObjectId.isValid(String(query.carrierId))) filter.carrierId = query.carrierId;
  if (query.carrier && mongoose.Types.ObjectId.isValid(String(query.carrier))) filter.carrier = query.carrier;
  if (query.status) filter.status = String(query.status);
  if (query.currency) filter.currency = String(query.currency).toUpperCase();
  if (query.q) {
    filter.$or = [
      { invoiceNumber: { $regex: String(query.q).slice(0, 100), $options: 'i' } },
      { payableNumber: { $regex: String(query.q).slice(0, 100), $options: 'i' } },
      { expenseNumber: { $regex: String(query.q).slice(0, 100), $options: 'i' } },
      { creditNoteNumber: { $regex: String(query.q).slice(0, 100), $options: 'i' } },
      { notes: { $regex: String(query.q).slice(0, 100), $options: 'i' } }
    ];
  }
  if (query.dueFrom || query.dueTo) {
    filter.dueDate = {};
    if (query.dueFrom) filter.dueDate.$gte = new Date(query.dueFrom);
    if (query.dueTo) filter.dueDate.$lte = new Date(query.dueTo);
  }
  if (query.overdue === 'true') {
    filter.status = { $nin: ['paid', 'void'] };
    filter.dueDate = { $lt: new Date(), ...filter.dueDate };
  }

  const docs = await Model.find(filter).sort({ createdAt: -1 }).limit(10000);

  const headers = CSV_HEADER_MAP[entityType];
  const rows = [headers.join(',')];

  for (const doc of docs) {
    const obj = doc.toObject();
    const row = headers.map((h) => {
      let val = obj[h];
      if (h === 'customer' && obj.customer && typeof obj.customer === 'object') val = obj.customer.name || obj.customer;
      if (h === 'carrier' && obj.carrier && typeof obj.carrier === 'object') val = obj.carrier.legalName || obj.carrier;
      if (h === 'carrierId') val = obj.carrierId || obj.carrier;
      if (h === 'originalInvoice' && obj.originalInvoice && typeof obj.originalInvoice === 'object') val = obj.originalInvoice.invoiceNumber || obj.originalInvoice;
      if (h === 'balanceDue') val = doc.balanceDue ? doc.balanceDue() : obj.balanceDue;
      rows.push(escapeCsv(formatValue(val)));
    });
    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  await recordAuditEvent({
    companyId: req.companyId || null,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'FINANCIAL_EXPORT',
    entityType: entityType,
    entityId: null,
    summary: `Exported ${docs.length} ${entityType} records to CSV`,
    metadata: { entityType, count: docs.length, format: 'csv' },
    isDemoData: Boolean(req.isDemoMode)
  });

  return { success: true, entityType, count: docs.length, format: 'csv', csv };
}

module.exports = {
  FinanceExportError,
  exportFinancials,
  EXPORTABLE_ENTITIES
};
