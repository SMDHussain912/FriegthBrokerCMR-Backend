const mongoose = require('mongoose');
const Carrier = require('../models/Carrier');

const CARRIER_FIELDS = new Set([
  'dotNumber',
  'mcNumber',
  'legalName',
  'dbaName',
  'contact',
  'authorityStatus',
  'authorityGrantDate',
  'safetyRating'
]);
const CARRIER_SORT_FIELDS = new Set([
  'legalName',
  'dotNumber',
  'mcNumber',
  'authorityStatus',
  'safetyRating',
  'overallStatus',
  'createdAt',
  'updatedAt'
]);
const MAX_AUDIT_ENTRIES = 100;

class CarrierApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function assertCompanyContext(req) {
  if (req.isDemoMode) {
    throw new CarrierApiError(403, 'DEMO_READ_ONLY', 'Demo carriers are read-only.');
  }
  if (!req.companyId || !req.membership) {
    throw new CarrierApiError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertCompanyRole(req, action) {
  assertCompanyContext(req);
  const brokerageRoles = action === 'CREATE'
    ? ['broker_owner', 'broker_admin', 'broker']
    : ['broker_owner', 'broker_admin'];
  const carrierRoles = action === 'CREATE'
    ? ['carrier_owner', 'carrier_admin']
    : ['carrier_owner', 'carrier_admin'];
  const allowedRoles = req.company?.type === 'carrier' ? carrierRoles : brokerageRoles;

  if (!allowedRoles.includes(req.membership.role)) {
    throw new CarrierApiError(403, 'FORBIDDEN_CARRIER_ROLE', `Your company role cannot ${action.toLowerCase()} carriers.`);
  }
}

function getCarrierCapabilities(req) {
  if (req.isDemoMode || !req.membership) {
    return { canCreate: false, canManage: false };
  }
  const isCarrierCompany = req.company?.type === 'carrier';
  const role = req.membership.role;
  const canCreate = isCarrierCompany
    ? ['carrier_owner', 'carrier_admin'].includes(role)
    : ['broker_owner', 'broker_admin', 'broker'].includes(role);
  const canManage = isCarrierCompany
    ? ['carrier_owner', 'carrier_admin'].includes(role)
    : ['broker_owner', 'broker_admin'].includes(role);
  return { canCreate, canManage };
}

function rejectUnknownFields(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CarrierApiError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  }
  const unknownFields = Object.keys(body).filter((field) => !allowedFields.has(field));
  if (unknownFields.length) {
    throw new CarrierApiError(400, 'INVALID_FIELDS', `Unsupported or protected fields: ${unknownFields.join(', ')}`);
  }
}

function normalizeString(value, field, maxLength, { uppercase = false, required = false } = {}) {
  if (value === undefined) {
    if (required) throw new CarrierApiError(400, 'REQUIRED_FIELD', `${field} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new CarrierApiError(400, 'INVALID_FIELD', `${field} must be a string.`);
  }
  const normalized = uppercase ? value.trim().toUpperCase() : value.trim();
  if (required && !normalized) {
    throw new CarrierApiError(400, 'REQUIRED_FIELD', `${field} is required.`);
  }
  if (normalized.length > maxLength) {
    throw new CarrierApiError(400, 'INVALID_FIELD', `${field} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function sanitizeContact(contact) {
  if (contact === undefined) return undefined;
  const allowedContactFields = new Set(['phone', 'email', 'address']);
  rejectUnknownFields(contact, allowedContactFields);
  const sanitized = {};
  const phone = normalizeString(contact.phone, 'contact.phone', 50);
  const email = normalizeString(contact.email, 'contact.email', 254);
  if (phone !== undefined) sanitized.phone = phone;
  if (email !== undefined) sanitized.email = email.toLowerCase();

  if (contact.address !== undefined) {
    const allowedAddressFields = new Set(['street', 'city', 'state', 'zip']);
    rejectUnknownFields(contact.address, allowedAddressFields);
    sanitized.address = {};
    for (const [field, maxLength] of Object.entries({ street: 200, city: 100, state: 2, zip: 20 })) {
      const value = normalizeString(contact.address[field], `contact.address.${field}`, maxLength);
      if (value !== undefined) sanitized.address[field] = field === 'state' ? value.toUpperCase() : value;
    }
  }
  return sanitized;
}

function sanitizeCarrierInput(body, { creating = false } = {}) {
  rejectUnknownFields(body, CARRIER_FIELDS);
  const payload = {};
  const fields = {
    dotNumber: { maxLength: 32, uppercase: true, required: creating },
    mcNumber: { maxLength: 32, uppercase: true, required: creating },
    legalName: { maxLength: 200, required: creating },
    dbaName: { maxLength: 200 },
    authorityStatus: { maxLength: 20, uppercase: true },
    safetyRating: { maxLength: 24, uppercase: true }
  };

  for (const [field, options] of Object.entries(fields)) {
    const value = normalizeString(body[field], field, options.maxLength, options);
    if (value !== undefined) payload[field] = value;
  }
  if (body.authorityGrantDate !== undefined) {
    if ((typeof body.authorityGrantDate !== 'string' && typeof body.authorityGrantDate !== 'number') || String(body.authorityGrantDate).trim() === '') {
      throw new CarrierApiError(400, 'INVALID_FIELD', 'authorityGrantDate must be a valid date.');
    }
    const date = new Date(body.authorityGrantDate);
    if (Number.isNaN(date.getTime())) {
      throw new CarrierApiError(400, 'INVALID_FIELD', 'authorityGrantDate must be a valid date.');
    }
    payload.authorityGrantDate = date;
  } else if (creating) {
    throw new CarrierApiError(400, 'REQUIRED_FIELD', 'authorityGrantDate is required.');
  }
  const contact = sanitizeContact(body.contact);
  if (contact !== undefined) payload.contact = contact;
  return payload;
}

function normalizePageValue(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CarrierApiError(400, 'INVALID_PAGINATION', 'Page and limit must be positive integers.');
  }
  return Math.min(parsed, maximum);
}

function carrierScope(req) {
  if (req.isDemoMode) return { isDemoData: true, isArchived: { $ne: true } };
  return { company: req.companyId, isDemoData: false, isArchived: { $ne: true } };
}

function toPublicCarrier(carrier) {
  const result = carrier.toObject ? carrier.toObject() : { ...carrier };
  delete result.auditLog;
  delete result.createdBy;
  delete result.updatedBy;
  delete result.archivedBy;
  for (const policy of result.insurancePolicies || []) delete policy.uploadedDocumentUri;
  return result;
}

function addAuditEntry(carrier, action, actorId, changedFields = [], reason) {
  const history = carrier.auditLog || [];
  carrier.auditLog = [...history, { action, actor: actorId, changedFields, reason }].slice(-MAX_AUDIT_ENTRIES);
}

function mapCarrierError(error) {
  if (error instanceof CarrierApiError) return error;
  if (error?.code === 11000) {
    return new CarrierApiError(409, 'DUPLICATE_CARRIER_IDENTIFIER', 'A carrier with this DOT or MC number already exists in this company.');
  }
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    return new CarrierApiError(400, 'VALIDATION_ERROR', error.message);
  }
  return error;
}

async function listCarriers(req, query) {
  const filter = carrierScope(req);
  const search = typeof query.query === 'string' ? query.query.trim() : '';
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = ['legalName', 'dbaName', 'dotNumber', 'mcNumber'].map((field) => ({
      [field]: { $regex: escaped, $options: 'i' }
    }));
  }

  const enumFilters = {
    authorityStatus: ['ACTIVE', 'REVOKED', 'INACTIVE', 'PENDING'],
    overallStatus: ['PASS', 'FAIL', 'NEEDS_REVIEW', 'UNKNOWN'],
    safetyRating: ['SATISFACTORY', 'CONDITIONAL', 'UNSATISFACTORY', 'NONE']
  };
  if (query.status !== undefined && query.overallStatus === undefined) {
    query = { ...query, overallStatus: query.status };
  }
  for (const [field, values] of Object.entries(enumFilters)) {
    if (query[field] !== undefined) {
      const value = String(query[field]).trim().toUpperCase();
      if (!values.includes(value)) throw new CarrierApiError(400, 'INVALID_FILTER', `Invalid ${field} filter.`);
      filter[field] = value;
    }
  }

  const page = normalizePageValue(query.page, 1, 1000000);
  const limit = normalizePageValue(query.limit, 25, 100);
  const sortBy = typeof query.sortBy === 'string' ? query.sortBy : 'legalName';
  if (!CARRIER_SORT_FIELDS.has(sortBy)) throw new CarrierApiError(400, 'INVALID_SORT', 'Unsupported carrier sort field.');
  const sortOrder = String(query.sortOrder || 'asc').toLowerCase();
  if (!['asc', 'desc'].includes(sortOrder)) throw new CarrierApiError(400, 'INVALID_SORT', 'sortOrder must be asc or desc.');
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: 1 };
  const projection = '-auditLog -createdBy -updatedBy -archivedBy';
  const [total, carriers] = await Promise.all([
    Carrier.countDocuments(filter),
    Carrier.find(filter).select(projection).sort(sort).skip((page - 1) * limit).limit(limit)
  ]);
  return {
    success: true,
    count: total,
    carriers: carriers.map(toPublicCarrier),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  };
}

async function findCarrierForTenant(req, carrierId, { includeAudit = false } = {}) {
  const filter = { _id: carrierId, ...carrierScope(req) };
  let carrierQuery = Carrier.findOne(filter);
  if (includeAudit) carrierQuery = carrierQuery.select('+auditLog');
  const carrier = await carrierQuery;
  if (carrier) return carrier;

  const archivedCarrier = await Carrier.findOne({
    _id: carrierId,
    ...(req.isDemoMode ? { isDemoData: true } : { company: req.companyId, isDemoData: false }),
    isArchived: true
  });
  if (archivedCarrier) throw new CarrierApiError(404, 'CARRIER_NOT_FOUND', 'Carrier not found.');

  const otherCarrier = await Carrier.findOne({ _id: carrierId });
  if (otherCarrier) throw new CarrierApiError(403, 'FORBIDDEN_TENANT_ACCESS', 'Carrier does not belong to the active company or context.');
  throw new CarrierApiError(404, 'CARRIER_NOT_FOUND', 'Carrier not found.');
}

async function createCarrier(req, body) {
  assertCompanyRole(req, 'CREATE');
  const payload = sanitizeCarrierInput(body, { creating: true });
  const duplicate = await Carrier.findOne({
    company: req.companyId,
    isDemoData: false,
    $or: [
      { dotNumber: payload.dotNumber },
      { mcNumber: payload.mcNumber }
    ]
  }).select('_id');
  if (duplicate) {
    throw new CarrierApiError(409, 'DUPLICATE_CARRIER_IDENTIFIER', 'A carrier with this DOT or MC number already exists in this company.');
  }
  const carrier = new Carrier({
    ...payload,
    company: req.companyId,
    isDemoData: false,
    createdBy: req.user.id,
    updatedBy: req.user.id,
    auditLog: [{ action: 'CREATED', actor: req.user.id, changedFields: Object.keys(payload) }]
  });
  await carrier.save();
  return toPublicCarrier(carrier);
}

async function updateCarrier(req, carrierId, body) {
  assertCompanyRole(req, 'UPDATE');
  if (!mongoose.Types.ObjectId.isValid(String(carrierId))) throw new CarrierApiError(400, 'INVALID_ID', 'Carrier ID must be a valid ObjectId.');
  const payload = sanitizeCarrierInput(body);
  if (Object.keys(payload).length === 0) throw new CarrierApiError(400, 'EMPTY_UPDATE', 'Provide at least one supported carrier field.');
  const carrier = await findCarrierForTenant(req, carrierId, { includeAudit: true });
  const changedFields = Object.keys(payload).filter((field) => JSON.stringify(carrier[field]) !== JSON.stringify(payload[field]));
  if (changedFields.length === 0) return toPublicCarrier(carrier);
  for (const [field, value] of Object.entries(payload)) carrier.set(field, value);
  carrier.updatedBy = req.user.id;
  addAuditEntry(carrier, 'UPDATED', req.user.id, changedFields);
  await carrier.save();
  return toPublicCarrier(carrier);
}

async function archiveCarrier(req, carrierId, body) {
  assertCompanyRole(req, 'ARCHIVE');
  if (!mongoose.Types.ObjectId.isValid(String(carrierId))) throw new CarrierApiError(400, 'INVALID_ID', 'Carrier ID must be a valid ObjectId.');
  rejectUnknownFields(body || {}, new Set(['reason']));
  const reason = body?.reason === undefined ? '' : normalizeString(body.reason, 'reason', 500);
  const carrier = await findCarrierForTenant(req, carrierId, { includeAudit: true });
  carrier.isArchived = true;
  carrier.archivedAt = new Date();
  carrier.archivedBy = req.user.id;
  carrier.updatedBy = req.user.id;
  addAuditEntry(carrier, 'ARCHIVED', req.user.id, reason ? ['isArchived', 'reason'] : ['isArchived'], reason);
  await carrier.save();
  return toPublicCarrier(carrier);
}

module.exports = {
  CarrierApiError,
  mapCarrierError,
  getCarrierCapabilities,
  listCarriers,
  createCarrier,
  findCarrierForTenant,
  updateCarrier,
  archiveCarrier,
  toPublicCarrier
};
