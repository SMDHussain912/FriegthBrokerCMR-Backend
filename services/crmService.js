const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Opportunity = require('../models/Opportunity');
const Quote = require('../models/Quote');
const RateAgreement = require('../models/RateAgreement');
const { recordAuditEvent } = require('./auditService');

class CrmError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CRM_WRITE_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'platform_admin']);
const CRM_READ_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer', 'platform_admin', 'platform_support']);

function assertCompany(req, { allowDemo = false } = {}) {
  const explicitDemo = req.headers && req.headers['x-demo-mode'] === 'true';
  const queryDemo = req.query && req.query.demo === 'true';
  if (req.isDemoMode || explicitDemo || queryDemo) {
    if (!allowDemo || explicitDemo || queryDemo) {
      throw new CrmError(403, 'DEMO_NOT_ALLOWED', 'This operation is not available in demo mode.');
    }
    return;
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new CrmError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertRole(req, allowed, action) {
  if (req.isDemoMode) return;
  const role = req.membership && req.membership.role;
  if (!role || !allowed.has(role)) {
    throw new CrmError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action}.`);
  }
}

function oid(id, label) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ''))) throw new CrmError(400, 'INVALID_ID', `${label} must be a valid ObjectId`);
}

function tenantFilter(req) {
  return req.isDemoMode ? { isDemoData: true } : { company: req.companyId, isDemoData: false };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

async function findTenantDoc(Model, req, id, label, { populate = null } = {}) {
  oid(id, label);
  let q = Model.findOne({ _id: id, ...tenantFilter(req) });
  if (populate) q = q.populate(populate);
  const doc = await q;
  if (doc) return doc;
  const exists = await Model.findById(id).select('company isDemoData');
  if (!exists) throw new CrmError(404, 'NOT_FOUND', `${label} not found.`);
  if (req.isDemoMode) throw new CrmError(403, 'FORBIDDEN_TENANT_ACCESS', `${label} is not accessible in demo mode.`);
  if (exists.isDemoData) throw new CrmError(403, 'FORBIDDEN_TENANT_ACCESS', `Demo ${label.toLowerCase()} cannot be accessed in company context.`);
  if (String(exists.company) !== String(req.companyId)) throw new CrmError(403, 'FORBIDDEN_TENANT_ACCESS', `${label} does not belong to the active company.`);
  throw new CrmError(404, 'NOT_FOUND', `${label} not found.`);
}

function ensureBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CrmError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  for (const f of ['company', 'isDemoData', 'createdBy', 'updatedBy', '_id', 'createdAt', 'updatedAt', '__v']) {
    if (Object.prototype.hasOwnProperty.call(body, f)) throw new CrmError(400, 'INVALID_FIELDS', `Protected field cannot be set: ${f}`);
  }
}

// Customers
const CUSTOMER_FIELDS = ['name','type','status','industry','website','phone','email','billingAddress','shippingAddress','contacts','paymentTerms','creditLimit','notes'];

async function listCustomers(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read customers');
  const filter = tenantFilter(req);
  if (query.type) filter.type = String(query.type);
  if (query.status) filter.status = String(query.status);
  if (query.q) filter.name = { $regex: String(query.q).slice(0, 100), $options: 'i' };

  // Pagination (bounded).
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(String(query.limit || '50'), 10) || 50), 200);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Customer.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    Customer.countDocuments(filter),
  ]);

  // Follow-up reminders: customers whose most recent activity is stale.
  const reminders = items.map((c) => {
    const updated = c.updatedAt || c.createdAt;
    const daysSince = updated ? Math.floor((Date.now() - new Date(updated).getTime()) / (1000 * 60 * 60 * 24)) : null;
    return {
      customerId: c._id,
      name: c.name,
      status: c.status,
      daysSinceLastActivity: daysSince,
      needsFollowUp: daysSince !== null && daysSince >= 30,
    };
  });

  return {
    success: true,
    count: items.length,
    total,
    page,
    limit,
    customers: items,
    reminders,
  };
}

async function createCustomer(req, body) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_WRITE_ROLES, 'create customers');
  ensureBody(body);
  const payload = pick(body, CUSTOMER_FIELDS);
  if (!payload.name || !String(payload.name).trim()) throw new CrmError(400, 'REQUIRED_FIELD', 'Customer name is required');
  const doc = await Customer.create({
    ...payload,
    name: String(payload.name).trim(),
    company: req.isDemoMode ? undefined : req.companyId,
    isDemoData: Boolean(req.isDemoMode),
    createdBy: req.user && req.user.id,
    updatedBy: req.user && req.user.id,
  });
  await recordAuditEvent({ companyId: req.companyId || null, actorId: req.user?.id, actorRole: req.membership?.role || req.user?.role, action: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: doc._id, summary: `Customer created: ${doc.name}`, metadata: { name: doc.name, type: doc.type }, isDemoData: Boolean(req.isDemoMode) });
  return { success: true, customer: doc };
}

async function getCustomer(req, id) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read customers');
  const doc = await findTenantDoc(Customer, req, id, 'Customer');
  return { success: true, customer: doc };
}

async function updateCustomer(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CRM_WRITE_ROLES, 'update customers');
  ensureBody(body);
  const doc = await findTenantDoc(Customer, req, id, 'Customer');
  const payload = pick(body, CUSTOMER_FIELDS);
  const changes = {};
  for (const [k, v] of Object.entries(payload)) {
    if (JSON.stringify(doc[k]) !== JSON.stringify(v)) changes[k] = { from: doc[k], to: v };
    doc.set(k, v);
  }
  if (doc.name) doc.name = String(doc.name).trim();
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  if (Object.keys(changes).length) await recordAuditEvent({ companyId: req.companyId, actorId: req.user?.id, actorRole: req.membership?.role, action: 'CUSTOMER_UPDATED', entityType: 'Customer', entityId: doc._id, summary: 'Customer updated', changes, isDemoData: false });
  return { success: true, customer: doc };
}

// Contacts
const CONTACT_FIELDS = ['customer','name','title','email','phone','mobile','isPrimary','status','notes'];

async function listContacts(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read contacts');
  const filter = tenantFilter(req);
  if (query.customer && mongoose.Types.ObjectId.isValid(String(query.customer))) filter.customer = query.customer;
  if (query.status) filter.status = String(query.status);
  const items = await Contact.find(filter).sort({ updatedAt: -1 }).limit(200);
  return { success: true, count: items.length, contacts: items };
}

async function createContact(req, body) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_WRITE_ROLES, 'create contacts');
  ensureBody(body);
  const payload = pick(body, CONTACT_FIELDS);
  if (!payload.name || !String(payload.name).trim()) throw new CrmError(400, 'REQUIRED_FIELD', 'Contact name is required');
  if (payload.customer) {
    oid(payload.customer, 'customer');
    await findTenantDoc(Customer, req, payload.customer, 'Customer');
  }
  const doc = await Contact.create({
    ...payload,
    name: String(payload.name).trim(),
    company: req.isDemoMode ? undefined : req.companyId,
    isDemoData: Boolean(req.isDemoMode),
    createdBy: req.user && req.user.id,
    updatedBy: req.user && req.user.id,
  });
  await recordAuditEvent({ companyId: req.companyId || null, actorId: req.user?.id, actorRole: req.membership?.role || req.user?.role, action: 'CONTACT_CREATED', entityType: 'Contact', entityId: doc._id, summary: `Contact created: ${doc.name}`, metadata: { name: doc.name, customerId: payload.customer || null }, isDemoData: Boolean(req.isDemoMode) });
  return { success: true, contact: doc };
}

async function getContact(req, id) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read contacts');
  const doc = await findTenantDoc(Contact, req, id, 'Contact');
  return { success: true, contact: doc };
}

async function updateContact(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CRM_WRITE_ROLES, 'update contacts');
  ensureBody(body);
  const doc = await findTenantDoc(Contact, req, id, 'Contact');
  const payload = pick(body, CONTACT_FIELDS);
  if (payload.customer) { oid(payload.customer, 'customer'); await findTenantDoc(Customer, req, payload.customer, 'Customer'); }
  for (const [k, v] of Object.entries(payload)) doc.set(k, v);
  if (doc.name) doc.name = String(doc.name).trim();
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  await recordAuditEvent({ companyId: req.companyId, actorId: req.user?.id, actorRole: req.membership?.role, action: 'CONTACT_UPDATED', entityType: 'Contact', entityId: doc._id, summary: 'Contact updated', isDemoData: false });
  return { success: true, contact: doc };
}

async function addCommunication(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CRM_WRITE_ROLES, 'log contact communications');
  const doc = await findTenantDoc(Contact, req, id, 'Contact');
  const entry = {
    type: ['note','call','email','sms','meeting','other'].includes(body?.type) ? body.type : 'note',
    subject: body?.subject ? String(body.subject).trim().slice(0, 200) : undefined,
    body: body?.body ? String(body.body).trim().slice(0, 4000) : undefined,
    occurredAt: body?.occurredAt ? new Date(body.occurredAt) : new Date(),
    createdBy: req.user && req.user.id,
  };
  doc.communications.push(entry);
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  await recordAuditEvent({ companyId: req.companyId, actorId: req.user?.id, actorRole: req.membership?.role, action: 'CONTACT_COMMUNICATION_LOGGED', entityType: 'Contact', entityId: doc._id, summary: 'Contact communication logged', metadata: { type: entry.type }, isDemoData: false });
  return { success: true, contact: doc };
}

module.exports = {
  CrmError,
  listCustomers, createCustomer, getCustomer, updateCustomer,
  listContacts, createContact, getContact, updateContact, addCommunication,
};

// Leads & pipeline
const LEAD_FIELDS = ['customer','name','companyName','email','phone','source','stage','estimatedValue','probability','expectedCloseDate','owner','notes','lostReason'];

async function listLeads(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read leads');
  const filter = tenantFilter(req);
  if (query.stage) filter.stage = String(query.stage);
  if (query.customer && mongoose.Types.ObjectId.isValid(String(query.customer))) filter.customer = query.customer;
  const items = await Lead.find(filter).sort({ updatedAt: -1 }).limit(200);
  return { success: true, count: items.length, leads: items };
}

async function createLead(req, body) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_WRITE_ROLES, 'create leads');
  ensureBody(body);
  const payload = pick(body, LEAD_FIELDS);
  if (!payload.name || !String(payload.name).trim()) throw new CrmError(400, 'REQUIRED_FIELD', 'Lead name is required');
  if (payload.customer) { oid(payload.customer, 'customer'); await findTenantDoc(Customer, req, payload.customer, 'Customer'); }
  const doc = await Lead.create({ ...payload, name: String(payload.name).trim(), company: req.isDemoMode ? undefined : req.companyId, isDemoData: Boolean(req.isDemoMode), createdBy: req.user?.id, updatedBy: req.user?.id });
  await recordAuditEvent({ companyId: req.companyId || null, actorId: req.user?.id, actorRole: req.membership?.role || req.user?.role, action: 'LEAD_CREATED', entityType: 'Lead', entityId: doc._id, summary: `Lead created: ${doc.name}`, metadata: { stage: doc.stage }, isDemoData: Boolean(req.isDemoMode) });
  return { success: true, lead: doc };
}

async function getLead(req, id) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read leads');
  return { success: true, lead: await findTenantDoc(Lead, req, id, 'Lead') };
}

async function updateLead(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CRM_WRITE_ROLES, 'update leads');
  ensureBody(body);
  const doc = await findTenantDoc(Lead, req, id, 'Lead');
  const payload = pick(body, LEAD_FIELDS);
  if (payload.customer) { oid(payload.customer, 'customer'); await findTenantDoc(Customer, req, payload.customer, 'Customer'); }
  const changes = {};
  if (payload.stage && payload.stage !== doc.stage) changes.stage = { from: doc.stage, to: payload.stage };
  for (const [k, v] of Object.entries(payload)) doc.set(k, v);
  if (doc.name) doc.name = String(doc.name).trim();
  doc.updatedBy = req.user?.id;
  await doc.save();
  await recordAuditEvent({ companyId: req.companyId, actorId: req.user?.id, actorRole: req.membership?.role, action: changes.stage ? 'LEAD_STAGE_UPDATED' : 'LEAD_UPDATED', entityType: 'Lead', entityId: doc._id, summary: 'Lead updated', changes: Object.keys(changes).length ? changes : undefined, isDemoData: false });
  return { success: true, lead: doc };
}

async function addLeadActivity(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CRM_WRITE_ROLES, 'log lead activities');
  const doc = await findTenantDoc(Lead, req, id, 'Lead');
  const entry = { type: body?.type || 'note', subject: body?.subject ? String(body.subject).trim().slice(0,200) : undefined, body: body?.body ? String(body.body).trim().slice(0,4000) : undefined, dueAt: body?.dueAt ? new Date(body.dueAt) : undefined, completedAt: body?.completedAt ? new Date(body.completedAt) : undefined, status: body?.status || 'open', createdBy: req.user?.id, occurredAt: body?.occurredAt ? new Date(body.occurredAt) : new Date() };
  doc.activities.push(entry);
  doc.updatedBy = req.user?.id;
  await doc.save();
  await recordAuditEvent({ companyId: req.companyId, actorId: req.user?.id, actorRole: req.membership?.role, action: 'LEAD_ACTIVITY_LOGGED', entityType: 'Lead', entityId: doc._id, summary: 'Lead activity logged', metadata: { type: entry.type }, isDemoData: false });
  return { success: true, lead: doc };
}

// Opportunities
const OPP_FIELDS = ['customer','lead','name','stage','amount','probability','expectedCloseDate','owner','notes','closeReason'];

async function listOpportunities(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read opportunities');
  const filter = tenantFilter(req);
  if (query.stage) filter.stage = String(query.stage);
  if (query.customer && mongoose.Types.ObjectId.isValid(String(query.customer))) filter.customer = query.customer;
  const items = await Opportunity.find(filter).sort({ updatedAt: -1 }).limit(200);
  return { success: true, count: items.length, opportunities: items };
}

async function createOpportunity(req, body) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_WRITE_ROLES, 'create opportunities');
  ensureBody(body);
  const payload = pick(body, OPP_FIELDS);
  if (!payload.name || !String(payload.name).trim()) throw new CrmError(400, 'REQUIRED_FIELD', 'Opportunity name is required');
  if (payload.customer) { oid(payload.customer, 'customer'); await findTenantDoc(Customer, req, payload.customer, 'Customer'); }
  if (payload.lead) { oid(payload.lead, 'lead'); await findTenantDoc(Lead, req, payload.lead, 'Lead'); }
  const doc = await Opportunity.create({ ...payload, name: String(payload.name).trim(), company: req.isDemoMode ? undefined : req.companyId, isDemoData: Boolean(req.isDemoMode), createdBy: req.user?.id, updatedBy: req.user?.id });
  await recordAuditEvent({ companyId: req.companyId || null, actorId: req.user?.id, actorRole: req.membership?.role || req.user?.role, action: 'OPPORTUNITY_CREATED', entityType: 'Opportunity', entityId: doc._id, summary: `Opportunity created: ${doc.name}`, metadata: { stage: doc.stage, amount: doc.amount }, isDemoData: Boolean(req.isDemoMode) });
  return { success: true, opportunity: doc };
}

async function getOpportunity(req, id) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read opportunities');
  return { success: true, opportunity: await findTenantDoc(Opportunity, req, id, 'Opportunity') };
}

async function updateOpportunity(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CRM_WRITE_ROLES, 'update opportunities');
  ensureBody(body);
  const doc = await findTenantDoc(Opportunity, req, id, 'Opportunity');
  const payload = pick(body, OPP_FIELDS);
  if (payload.customer) { oid(payload.customer, 'customer'); await findTenantDoc(Customer, req, payload.customer, 'Customer'); }
  if (payload.lead) { oid(payload.lead, 'lead'); await findTenantDoc(Lead, req, payload.lead, 'Lead'); }
  const changes = {};
  if (payload.stage && payload.stage !== doc.stage) changes.stage = { from: doc.stage, to: payload.stage };
  for (const [k, v] of Object.entries(payload)) doc.set(k, v);
  if (doc.name) doc.name = String(doc.name).trim();
  doc.updatedBy = req.user?.id;
  await doc.save();
  await recordAuditEvent({ companyId: req.companyId, actorId: req.user?.id, actorRole: req.membership?.role, action: changes.stage ? 'OPPORTUNITY_STAGE_UPDATED' : 'OPPORTUNITY_UPDATED', entityType: 'Opportunity', entityId: doc._id, summary: 'Opportunity updated', changes: Object.keys(changes).length ? changes : undefined, isDemoData: false });
  return { success: true, opportunity: doc };
}

async function addOpportunityActivity(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CRM_WRITE_ROLES, 'log opportunity activities');
  const doc = await findTenantDoc(Opportunity, req, id, 'Opportunity');
  const entry = { type: body?.type || 'note', subject: body?.subject ? String(body.subject).trim().slice(0,200) : undefined, body: body?.body ? String(body.body).trim().slice(0,4000) : undefined, dueAt: body?.dueAt ? new Date(body.dueAt) : undefined, completedAt: body?.completedAt ? new Date(body.completedAt) : undefined, status: body?.status || 'open', createdBy: req.user?.id, occurredAt: body?.occurredAt ? new Date(body.occurredAt) : new Date() };
  doc.activities.push(entry);
  doc.updatedBy = req.user?.id;
  await doc.save();
  await recordAuditEvent({ companyId: req.companyId, actorId: req.user?.id, actorRole: req.membership?.role, action: 'OPPORTUNITY_ACTIVITY_LOGGED', entityType: 'Opportunity', entityId: doc._id, summary: 'Opportunity activity logged', metadata: { type: entry.type }, isDemoData: false });
  return { success: true, opportunity: doc };
}

module.exports.listLeads = listLeads; module.exports.createLead = createLead; module.exports.getLead = getLead; module.exports.updateLead = updateLead; module.exports.addLeadActivity = addLeadActivity;
module.exports.listOpportunities = listOpportunities; module.exports.createOpportunity = createOpportunity; module.exports.getOpportunity = getOpportunity; module.exports.updateOpportunity = updateOpportunity; module.exports.addOpportunityActivity = addOpportunityActivity;

// Quotes
const QUOTE_FIELDS = ['customer','opportunity','quoteNumber','status','currency','lineItems','subtotal','total','validUntil','notes','terms'];
function computeQuoteTotals(payload) {
  const items = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  let subtotal = 0;
  for (const it of items) {
    const amt = typeof it.amount === 'number' ? it.amount : (Number(it.quantity || 1) * Number(it.rate || 0));
    subtotal += Number.isFinite(amt) ? amt : 0;
  }
  if (payload.subtotal === undefined) payload.subtotal = subtotal;
  if (payload.total === undefined) payload.total = payload.subtotal;
}

async function listQuotes(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read quotes');
  const filter = tenantFilter(req);
  if (query.status) filter.status = String(query.status);
  if (query.customer && mongoose.Types.ObjectId.isValid(String(query.customer))) filter.customer = query.customer;
  const items = await Quote.find(filter).sort({ updatedAt: -1 }).limit(200);
  return { success: true, count: items.length, quotes: items };
}

async function createQuote(req, body) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_WRITE_ROLES, 'create quotes');
  ensureBody(body);
  const payload = pick(body, QUOTE_FIELDS);
  if (payload.customer) { oid(payload.customer, 'customer'); await findTenantDoc(Customer, req, payload.customer, 'Customer'); }
  if (payload.opportunity) { oid(payload.opportunity, 'opportunity'); await findTenantDoc(Opportunity, req, payload.opportunity, 'Opportunity'); }
  computeQuoteTotals(payload);
  if (!payload.quoteNumber) payload.quoteNumber = `Q-${Date.now().toString(36).toUpperCase()}`;
  const doc = await Quote.create({ ...payload, company: req.isDemoMode ? undefined : req.companyId, isDemoData: Boolean(req.isDemoMode), createdBy: req.user?.id, updatedBy: req.user?.id });
  await recordAuditEvent({ companyId: req.companyId || null, actorId: req.user?.id, actorRole: req.membership?.role || req.user?.role, action: 'QUOTE_CREATED', entityType: 'Quote', entityId: doc._id, summary: `Quote created: ${doc.quoteNumber}`, metadata: { status: doc.status, total: doc.total }, isDemoData: Boolean(req.isDemoMode) });
  return { success: true, quote: doc };
}

async function getQuote(req, id) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read quotes');
  return { success: true, quote: await findTenantDoc(Quote, req, id, 'Quote') };
}

async function updateQuote(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CRM_WRITE_ROLES, 'update quotes');
  ensureBody(body);
  const doc = await findTenantDoc(Quote, req, id, 'Quote');
  const payload = pick(body, QUOTE_FIELDS);
  if (payload.customer) { oid(payload.customer, 'customer'); await findTenantDoc(Customer, req, payload.customer, 'Customer'); }
  if (payload.opportunity) { oid(payload.opportunity, 'opportunity'); await findTenantDoc(Opportunity, req, payload.opportunity, 'Opportunity'); }
  const changes = {};
  if (payload.status && payload.status !== doc.status) changes.status = { from: doc.status, to: payload.status };
  computeQuoteTotals(payload);
  for (const [k, v] of Object.entries(payload)) doc.set(k, v);
  doc.updatedBy = req.user?.id;
  await doc.save();
  await recordAuditEvent({ companyId: req.companyId, actorId: req.user?.id, actorRole: req.membership?.role, action: changes.status ? 'QUOTE_STATUS_UPDATED' : 'QUOTE_UPDATED', entityType: 'Quote', entityId: doc._id, summary: 'Quote updated', changes: Object.keys(changes).length ? changes : undefined, isDemoData: false });
  return { success: true, quote: doc };
}

// Rate agreements / contracts & pricing
const RATE_FIELDS = ['customer','name','status','effectiveDate','expirationDate','currency','paymentTerms','lanes','notes'];

async function listRateAgreements(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read rate agreements');
  const filter = tenantFilter(req);
  if (query.status) filter.status = String(query.status);
  if (query.customer && mongoose.Types.ObjectId.isValid(String(query.customer))) filter.customer = query.customer;
  const items = await RateAgreement.find(filter).sort({ updatedAt: -1 }).limit(200);
  return { success: true, count: items.length, rateAgreements: items };
}

async function createRateAgreement(req, body) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_WRITE_ROLES, 'create rate agreements');
  ensureBody(body);
  const payload = pick(body, RATE_FIELDS);
  if (!payload.name || !String(payload.name).trim()) throw new CrmError(400, 'REQUIRED_FIELD', 'Rate agreement name is required');
  if (payload.customer) { oid(payload.customer, 'customer'); await findTenantDoc(Customer, req, payload.customer, 'Customer'); }
  const doc = await RateAgreement.create({ ...payload, name: String(payload.name).trim(), company: req.isDemoMode ? undefined : req.companyId, isDemoData: Boolean(req.isDemoMode), createdBy: req.user?.id, updatedBy: req.user?.id });
  await recordAuditEvent({ companyId: req.companyId || null, actorId: req.user?.id, actorRole: req.membership?.role || req.user?.role, action: 'RATE_AGREEMENT_CREATED', entityType: 'RateAgreement', entityId: doc._id, summary: `Rate agreement created: ${doc.name}`, metadata: { status: doc.status }, isDemoData: Boolean(req.isDemoMode) });
  return { success: true, rateAgreement: doc };
}

async function getRateAgreement(req, id) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, CRM_READ_ROLES, 'read rate agreements');
  return { success: true, rateAgreement: await findTenantDoc(RateAgreement, req, id, 'Rate agreement') };
}

async function updateRateAgreement(req, id, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CRM_WRITE_ROLES, 'update rate agreements');
  ensureBody(body);
  const doc = await findTenantDoc(RateAgreement, req, id, 'Rate agreement');
  const payload = pick(body, RATE_FIELDS);
  if (payload.customer) { oid(payload.customer, 'customer'); await findTenantDoc(Customer, req, payload.customer, 'Customer'); }
  const changes = {};
  if (payload.status && payload.status !== doc.status) changes.status = { from: doc.status, to: payload.status };
  for (const [k, v] of Object.entries(payload)) doc.set(k, v);
  if (doc.name) doc.name = String(doc.name).trim();
  doc.updatedBy = req.user?.id;
  await doc.save();
  await recordAuditEvent({ companyId: req.companyId, actorId: req.user?.id, actorRole: req.membership?.role, action: changes.status ? 'RATE_AGREEMENT_STATUS_UPDATED' : 'RATE_AGREEMENT_UPDATED', entityType: 'RateAgreement', entityId: doc._id, summary: 'Rate agreement updated', changes: Object.keys(changes).length ? changes : undefined, isDemoData: false });
  return { success: true, rateAgreement: doc };
}

module.exports.listQuotes = listQuotes; module.exports.createQuote = createQuote; module.exports.getQuote = getQuote; module.exports.updateQuote = updateQuote;
module.exports.listRateAgreements = listRateAgreements; module.exports.createRateAgreement = createRateAgreement; module.exports.getRateAgreement = getRateAgreement; module.exports.updateRateAgreement = updateRateAgreement;

async function deleteContact(req, id) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CRM_WRITE_ROLES, 'delete contacts');
  const doc = await findTenantDoc(Contact, req, id, 'Contact');
  await Contact.deleteOne({ _id: doc._id, company: req.companyId, isDemoData: false });
  await recordAuditEvent({ companyId: req.companyId, actorId: req.user?.id, actorRole: req.membership?.role, action: 'CONTACT_DELETED', entityType: 'Contact', entityId: id, summary: 'Contact deleted', isDemoData: false });
  return { success: true };
}

async function deleteCustomer(req, id) {
  assertCompany(req, { allowDemo: false }); assertRole(req, CRM_WRITE_ROLES, 'delete customers');
  const doc = await findTenantDoc(Customer, req, id, 'Customer');
  await Customer.deleteOne({ _id: doc._id, company: req.companyId, isDemoData: false });
  await recordAuditEvent({ companyId: req.companyId, actorId: req.user?.id, actorRole: req.membership?.role, action: 'CUSTOMER_DELETED', entityType: 'Customer', entityId: id, summary: 'Customer deleted', isDemoData: false });
  return { success: true };
}

module.exports.deleteContact = deleteContact;
module.exports.deleteCustomer = deleteCustomer;
