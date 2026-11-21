const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Customer = require('../models/Customer');
const Load = require('../models/Load');
const { recordAuditEvent } = require('./auditService');

class InvoiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const INVOICE_WRITE_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'finance', 'platform_admin']);
const INVOICE_READ_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer', 'platform_admin', 'platform_support']);

const INVOICE_STATUSES = new Set(['draft', 'sent', 'paid', 'overdue', 'void']);

function assertCompany(req, { allowDemo = false } = {}) {
  const explicitDemo = req.headers && req.headers['x-demo-mode'] === 'true';
  const queryDemo = req.query && req.query.demo === 'true';
  if (req.isDemoMode || explicitDemo || queryDemo) {
    if (!allowDemo || explicitDemo || queryDemo) {
      throw new InvoiceError(403, 'DEMO_NOT_ALLOWED', 'This operation is not available in demo mode.');
    }
    return;
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new InvoiceError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertRole(req, allowed, action) {
  if (req.isDemoMode) return;
  const role = req.membership && req.membership.role;
  if (!role || !allowed.has(role)) {
    throw new InvoiceError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action}.`);
  }
}

function oid(id, label) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ''))) throw new InvoiceError(400, 'INVALID_ID', `${label} must be a valid ObjectId`);
}

function ensureBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvoiceError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  for (const f of ['company', 'isDemoData', 'createdBy', 'updatedBy', '_id', 'createdAt', 'updatedAt', '__v']) {
    if (Object.prototype.hasOwnProperty.call(body, f)) throw new InvoiceError(400, 'INVALID_FIELDS', `Protected field cannot be set: ${f}`);
  }
}

function tenantFilter(req) {
  return req.isDemoMode ? { isDemoData: true } : { company: req.companyId, isDemoData: false };
}

async function findTenantDoc(Model, req, id, label, { populate = null } = {}) {
  oid(id, label);
  let q = Model.findOne({ _id: id, ...tenantFilter(req) });
  if (populate) q = q.populate(populate);
  const doc = await q;
  if (doc) return doc;
  const exists = await Model.findById(id).select('company isDemoData');
  if (!exists) throw new InvoiceError(404, 'NOT_FOUND', `${label} not found.`);
  if (req.isDemoMode) throw new InvoiceError(403, 'FORBIDDEN_TENANT_ACCESS', `${label} is not accessible in demo mode.`);
  if (exists.isDemoData) throw new InvoiceError(403, 'FORBIDDEN_TENANT_ACCESS', `Demo ${label.toLowerCase()} cannot be accessed in company context.`);
  if (String(exists.company) !== String(req.companyId)) throw new InvoiceError(403, 'FORBIDDEN_TENANT_ACCESS', `${label} does not belong to the active company.`);
  throw new InvoiceError(404, 'NOT_FOUND', `${label} not found.`);
}

function nextInvoiceNumber(existing) {
  const nums = existing.map((e) => {
    const m = String(e.invoiceNumber).match(/INV-(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const next = Math.max(0, ...nums) + 1;
  return `INV-${String(next).padStart(5, '0')}`;
}

async function listInvoices(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, INVOICE_READ_ROLES, 'read invoices');
  const filter = tenantFilter(req);
  if (query.customer && mongoose.Types.ObjectId.isValid(String(query.customer))) filter.customer = query.customer;
  if (query.status) filter.status = String(query.status);
  if (query.currency) filter.currency = String(query.currency).toUpperCase();
  if (query.q) {
    filter.$or = [
      { invoiceNumber: { $regex: String(query.q).slice(0, 100), $options: 'i' } },
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
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(String(query.limit || '50'), 10) || 50), 200);
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Invoice.find(filter).populate('customer', 'name type status email').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Invoice.countDocuments(filter)
  ]);
  return {
    success: true,
    count: items.length,
    total,
    page,
    limit,
    invoices: items.map((i) => i.toObject())
  };
}

async function createInvoice(req, body) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, INVOICE_WRITE_ROLES, 'create invoices');
  ensureBody(body);
  if (!body.customer || !mongoose.Types.ObjectId.isValid(String(body.customer))) throw new InvoiceError(400, 'REQUIRED_FIELD', 'A valid customer is required.');
  await findTenantDoc(Customer, req, body.customer, 'Customer');
  const lineItems = Array.isArray(body.lineItems) ? body.lineItems : [];
  if (lineItems.length === 0) throw new InvoiceError(400, 'REQUIRED_FIELD', 'At least one line item is required.');
  for (const item of lineItems) {
    if (!item.description || !String(item.description).trim()) throw new InvoiceError(400, 'REQUIRED_FIELD', 'Line item description is required.');
    if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) < 0) throw new InvoiceError(400, 'INVALID_FIELD', 'Line item quantity must be a non-negative number.');
    if (!Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) < 0) throw new InvoiceError(400, 'INVALID_FIELD', 'Line item unit price must be a non-negative number.');
  }
  const existing = await Invoice.findOne(tenantFilter(req)).sort({ createdAt: -1 });
  const invoiceNumber = nextInvoiceNumber(existing ? [existing] : []);
  const dueDate = body.dueDate ? new Date(body.dueDate) : undefined;
  const doc = await Invoice.create({
    ...body,
    invoiceNumber,
    customer: body.customer,
    lineItems,
    dueDate,
    status: body.status || 'draft',
    currency: body.currency || 'USD',
    company: req.isDemoMode ? undefined : req.companyId,
    isDemoData: Boolean(req.isDemoMode),
    createdBy: req.user && req.user.id,
    updatedBy: req.user && req.user.id
  });
  await recordAuditEvent({
    companyId: req.companyId || null,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'INVOICE_CREATED',
    entityType: 'Invoice',
    entityId: doc._id,
    summary: `Invoice created: ${doc.invoiceNumber}`,
    metadata: { invoiceNumber: doc.invoiceNumber, customer: doc.customer, amount: doc.amount, currency: doc.currency },
    isDemoData: Boolean(req.isDemoMode)
  });
  return { success: true, invoice: doc.toObject() };
}

async function getInvoice(req, id) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, INVOICE_READ_ROLES, 'read invoices');
  const doc = await findTenantDoc(Invoice, req, id, 'Invoice');
  return { success: true, invoice: doc.toObject() };
}

async function updateInvoice(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, INVOICE_WRITE_ROLES, 'update invoices');
  ensureBody(body);
  const doc = await findTenantDoc(Invoice, req, id, 'Invoice');
  if (doc.status === 'void') throw new InvoiceError(409, 'INVOICE_VOIDED', 'Cannot update a voided invoice.');
  if (doc.status === 'paid') throw new InvoiceError(409, 'INVOICE_PAID', 'Cannot update a paid invoice.');
  const allowedFields = ['customer', 'status', 'currency', 'dueDate', 'lineItems', 'notes', 'linkedLoads'];
  const changes = {};
  for (const k of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      const prev = JSON.stringify(doc[k]);
      const next = JSON.stringify(body[k]);
      if (prev !== next) changes[k] = { from: doc[k], to: body[k] };
      doc.set(k, body[k]);
    }
  }
  if (body.customer && mongoose.Types.ObjectId.isValid(String(body.customer))) {
    await findTenantDoc(Customer, req, body.customer, 'Customer');
  }
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  if (Object.keys(changes).length) {
    await recordAuditEvent({
      companyId: req.companyId,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'INVOICE_UPDATED',
      entityType: 'Invoice',
      entityId: doc._id,
      summary: 'Invoice updated',
      changes,
      metadata: { invoiceNumber: doc.invoiceNumber },
      isDemoData: false
    });
  }
  return { success: true, invoice: doc.toObject() };
}

async function voidInvoice(req, id) {
  assertCompany(req, { allowDemo: false }); assertRole(req, INVOICE_WRITE_ROLES, 'void invoices');
  const doc = await findTenantDoc(Invoice, req, id, 'Invoice');
  if (doc.status === 'void') throw new InvoiceError(409, 'INVOICE_VOIDED', 'Invoice is already voided.');
  if (doc.status === 'paid') throw new InvoiceError(409, 'INVOICE_PAID', 'Cannot void a paid invoice.');
  doc.status = 'void';
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'INVOICE_VOIDED',
    entityType: 'Invoice',
    entityId: doc._id,
    summary: 'Invoice voided',
    metadata: { invoiceNumber: doc.invoiceNumber, previousStatus: doc.status },
    isDemoData: false
  });
  return { success: true, invoice: doc.toObject() };
}

async function recordPayment(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, INVOICE_WRITE_ROLES, 'record invoice payment');
  ensureBody(body);
  const doc = await findTenantDoc(Invoice, req, id, 'Invoice');
  if (doc.status === 'void') throw new InvoiceError(409, 'INVOICE_VOIDED', 'Cannot record payment on a voided invoice.');
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new InvoiceError(400, 'INVALID_FIELD', 'Payment amount must be a positive number.');
  const balance = doc.balanceDue();
  if (amount > balance) throw new InvoiceError(400, 'OVERPAYMENT', `Payment amount ${amount} exceeds balance due ${balance}.`);
  doc.paidAmount = Number(doc.paidAmount || 0) + amount;
  if (doc.paidAmount >= doc.amount) doc.status = 'paid';
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'INVOICE_PAYMENT_RECORDED',
    entityType: 'Invoice',
    entityId: doc._id,
    summary: `Payment recorded: ${amount} ${doc.currency}`,
    metadata: { invoiceNumber: doc.invoiceNumber, amount, newPaidAmount: doc.paidAmount, newBalance: doc.balanceDue(), newStatus: doc.status },
    isDemoData: false
  });
  return { success: true, invoice: doc.toObject() };
}

module.exports = {
  InvoiceError,
  listInvoices, createInvoice, getInvoice, updateInvoice, voidInvoice, recordPayment,
  INVOICE_STATUSES
};
