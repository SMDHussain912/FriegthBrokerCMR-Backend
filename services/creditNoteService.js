const mongoose = require('mongoose');
const CreditNote = require('../models/CreditNote');
const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const { recordAuditEvent } = require('./auditService');

class CreditNoteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CREDIT_NOTE_WRITE_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'finance', 'platform_admin']);
const CREDIT_NOTE_READ_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer', 'platform_admin', 'platform_support']);

const CREDIT_NOTE_STATUSES = new Set(['draft', 'issued', 'applied', 'void']);

function assertCompany(req, { allowDemo = false } = {}) {
  const explicitDemo = req.headers && req.headers['x-demo-mode'] === 'true';
  const queryDemo = req.query && req.query.demo === 'true';
  if (req.isDemoMode || explicitDemo || queryDemo) {
    if (!allowDemo || explicitDemo || queryDemo) {
      throw new CreditNoteError(403, 'DEMO_NOT_ALLOWED', 'This operation is not available in demo mode.');
    }
    return;
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new CreditNoteError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertRole(req, allowed, action) {
  if (req.isDemoMode) return;
  const role = req.membership && req.membership.role;
  if (!role || !allowed.has(role)) {
    throw new CreditNoteError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action}.`);
  }
}

function oid(id, label) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ''))) throw new CreditNoteError(400, 'INVALID_ID', `${label} must be a valid ObjectId`);
}

function ensureBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CreditNoteError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  for (const f of ['company', 'isDemoData', 'createdBy', 'updatedBy', '_id', 'createdAt', 'updatedAt', '__v']) {
    if (Object.prototype.hasOwnProperty.call(body, f)) throw new CreditNoteError(400, 'INVALID_FIELDS', `Protected field cannot be set: ${f}`);
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
  if (!exists) throw new CreditNoteError(404, 'NOT_FOUND', `${label} not found.`);
  if (req.isDemoMode) throw new CreditNoteError(403, 'FORBIDDEN_TENANT_ACCESS', `${label} is not accessible in demo mode.`);
  if (exists.isDemoData) throw new CreditNoteError(403, 'FORBIDDEN_TENANT_ACCESS', `Demo ${label.toLowerCase()} cannot be accessed in company context.`);
  if (String(exists.company) !== String(req.companyId)) throw new CreditNoteError(403, 'FORBIDDEN_TENANT_ACCESS', `${label} does not belong to the active company.`);
  throw new CreditNoteError(404, 'NOT_FOUND', `${label} not found.`);
}

function nextCreditNoteNumber(existing) {
  const nums = existing.map((e) => {
    const m = String(e.creditNoteNumber).match(/CN-(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const next = Math.max(0, ...nums) + 1;
  return `CN-${String(next).padStart(5, '0')}`;
}

async function listCreditNotes(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CREDIT_NOTE_READ_ROLES, 'read credit notes');
  const filter = tenantFilter(req);
  if (query.customer && mongoose.Types.ObjectId.isValid(String(query.customer))) filter.customer = query.customer;
  if (query.originalInvoice && mongoose.Types.ObjectId.isValid(String(query.originalInvoice))) filter.originalInvoice = query.originalInvoice;
  if (query.status) filter.status = String(query.status);
  if (query.currency) filter.currency = String(query.currency).toUpperCase();
  if (query.q) {
    filter.$or = [
      { creditNoteNumber: { $regex: String(query.q).slice(0, 100), $options: 'i' } },
      { reason: { $regex: String(query.q).slice(0, 100), $options: 'i' } },
      { notes: { $regex: String(query.q).slice(0, 100), $options: 'i' } }
    ];
  }
  if (query.dueFrom || query.dueTo) {
    filter.dueDate = {};
    if (query.dueFrom) filter.dueDate.$gte = new Date(query.dueFrom);
    if (query.dueTo) filter.dueDate.$lte = new Date(query.dueTo);
  }
  if (query.overdue === 'true') {
    filter.status = { $nin: ['applied', 'void'] };
    filter.dueDate = { $lt: new Date(), ...filter.dueDate };
  }
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(String(query.limit || '50'), 10) || 50), 200);
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    CreditNote.find(filter).populate('customer', 'name type status email').populate('originalInvoice', 'invoiceNumber status amount').sort({ createdAt: -1 }).skip(skip).limit(limit),
    CreditNote.countDocuments(filter)
  ]);
  return {
    success: true,
    count: items.length,
    total,
    page,
    limit,
    creditNotes: items.map((i) => i.toObject())
  };
}

async function createCreditNote(req, body) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CREDIT_NOTE_WRITE_ROLES, 'create credit notes');
  ensureBody(body);
  if (!body.customer || !mongoose.Types.ObjectId.isValid(String(body.customer))) throw new CreditNoteError(400, 'REQUIRED_FIELD', 'A valid customer is required.');
  await findTenantDoc(Customer, req, body.customer, 'Customer');
  if (body.originalInvoice && mongoose.Types.ObjectId.isValid(String(body.originalInvoice))) {
    await findTenantDoc(Invoice, req, body.originalInvoice, 'Invoice');
  }
  const lineItems = Array.isArray(body.lineItems) ? body.lineItems : [];
  if (lineItems.length === 0) throw new CreditNoteError(400, 'REQUIRED_FIELD', 'At least one line item is required.');
  for (const item of lineItems) {
    if (!item.description || !String(item.description).trim()) throw new CreditNoteError(400, 'REQUIRED_FIELD', 'Line item description is required.');
    if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) < 0) throw new CreditNoteError(400, 'INVALID_FIELD', 'Line item quantity must be a non-negative number.');
    if (!Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) < 0) throw new CreditNoteError(400, 'INVALID_FIELD', 'Line item unit price must be a non-negative number.');
  }
  const existing = await CreditNote.findOne(tenantFilter(req)).sort({ createdAt: -1 });
  const creditNoteNumber = nextCreditNoteNumber(existing ? [existing] : []);
  const dueDate = body.dueDate ? new Date(body.dueDate) : undefined;
  const doc = await CreditNote.create({
    ...body,
    creditNoteNumber,
    customer: body.customer,
    originalInvoice: body.originalInvoice || undefined,
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
    action: 'CREDIT_NOTE_CREATED',
    entityType: 'CreditNote',
    entityId: doc._id,
    summary: `Credit note created: ${doc.creditNoteNumber}`,
    metadata: { creditNoteNumber: doc.creditNoteNumber, customer: doc.customer, amount: doc.amount, currency: doc.currency },
    isDemoData: Boolean(req.isDemoMode)
  });
  return { success: true, creditNote: doc.toObject() };
}

async function getCreditNote(req, id) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CREDIT_NOTE_READ_ROLES, 'read credit notes');
  const doc = await findTenantDoc(CreditNote, req, id, 'Credit Note');
  return { success: true, creditNote: doc.toObject() };
}

async function updateCreditNote(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CREDIT_NOTE_WRITE_ROLES, 'update credit notes');
  ensureBody(body);
  const doc = await findTenantDoc(CreditNote, req, id, 'Credit Note');
  if (doc.status === 'void') throw new CreditNoteError(409, 'CREDIT_NOTE_VOIDED', 'Cannot update a voided credit note.');
  if (doc.status === 'applied') throw new CreditNoteError(409, 'CREDIT_NOTE_APPLIED', 'Cannot update an applied credit note.');
  const allowedFields = ['customer', 'originalInvoice', 'status', 'currency', 'dueDate', 'lineItems', 'reason', 'notes', 'linkedLoads'];
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
  if (body.originalInvoice && mongoose.Types.ObjectId.isValid(String(body.originalInvoice))) {
    await findTenantDoc(Invoice, req, body.originalInvoice, 'Invoice');
  }
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  if (Object.keys(changes).length) {
    await recordAuditEvent({
      companyId: req.companyId,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'CREDIT_NOTE_UPDATED',
      entityType: 'CreditNote',
      entityId: doc._id,
      summary: 'Credit note updated',
      changes,
      metadata: { creditNoteNumber: doc.creditNoteNumber },
      isDemoData: false
    });
  }
  return { success: true, creditNote: doc.toObject() };
}

async function voidCreditNote(req, id) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CREDIT_NOTE_WRITE_ROLES, 'void credit notes');
  const doc = await findTenantDoc(CreditNote, req, id, 'Credit Note');
  if (doc.status === 'void') throw new CreditNoteError(409, 'CREDIT_NOTE_VOIDED', 'Credit note is already voided.');
  if (doc.status === 'applied') throw new CreditNoteError(409, 'CREDIT_NOTE_APPLIED', 'Cannot void an applied credit note.');
  doc.status = 'void';
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'CREDIT_NOTE_VOIDED',
    entityType: 'CreditNote',
    entityId: doc._id,
    summary: 'Credit note voided',
    metadata: { creditNoteNumber: doc.creditNoteNumber, previousStatus: doc.status },
    isDemoData: false
  });
  return { success: true, creditNote: doc.toObject() };
}

async function applyCreditNote(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CREDIT_NOTE_WRITE_ROLES, 'apply credit notes');
  ensureBody(body);
  const doc = await findTenantDoc(CreditNote, req, id, 'Credit Note');
  if (doc.status === 'void') throw new CreditNoteError(409, 'CREDIT_NOTE_VOIDED', 'Cannot apply a voided credit note.');
  if (doc.status === 'applied') throw new CreditNoteError(409, 'CREDIT_NOTE_APPLIED', 'Credit note is already applied.');
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new CreditNoteError(400, 'INVALID_FIELD', 'Application amount must be a positive number.');
  const balance = doc.balanceDue();
  if (amount > balance) throw new CreditNoteError(400, 'OVERAPPLYMENT', `Application amount ${amount} exceeds balance due ${balance}.`);
  doc.appliedAmount = Number(doc.appliedAmount || 0) + amount;
  if (doc.appliedAmount >= doc.amount) doc.status = 'applied';
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'CREDIT_NOTE_APPLIED',
    entityType: 'CreditNote',
    entityId: doc._id,
    summary: `Credit note applied: ${amount} ${doc.currency}`,
    metadata: { creditNoteNumber: doc.creditNoteNumber, amount, newAppliedAmount: doc.appliedAmount, newBalance: doc.balanceDue(), newStatus: doc.status },
    isDemoData: false
  });
  return { success: true, creditNote: doc.toObject() };
}

module.exports = {
  CreditNoteError,
  listCreditNotes, createCreditNote, getCreditNote, updateCreditNote, voidCreditNote, applyCreditNote,
  CREDIT_NOTE_STATUSES
};
