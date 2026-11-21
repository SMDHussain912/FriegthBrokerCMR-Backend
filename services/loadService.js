const mongoose = require('mongoose');
const Load = require('../models/Load');
const Carrier = require('../models/Carrier');
const CarrierAssignment = require('../models/CarrierAssignment');
const { evaluateCarrierForLoad } = require('./vettingEngine');
const { assignCarrierToLoad } = require('./assignmentService');
const { findCarrierForTenant, CarrierApiError } = require('./carrierService');
const { recordAuditEvent } = require('./auditService');

const LOAD_WRITE_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'platform_admin']);
const LOAD_READ_ROLES = new Set([
  'broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer', 'platform_admin', 'platform_support'
]);
const ELIGIBILITY_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'platform_admin']);
const ASSIGNMENT_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'platform_admin']);

class LoadApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const assertCompanyContext = (req, { allowDemo = false } = {}) => {
  if (req.isDemoMode) {
    if (!allowDemo) throw new LoadApiError(403, 'DEMO_NOT_ALLOWED', 'This load operation is not available in demo mode.');
    return;
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new LoadApiError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
};

const assertRole = (req, allowedRoles, action) => {
  if (req.isDemoMode) return; // demo operations (read/explicit demo flows) are role-gated by allowDemo/context elsewhere
  const role = req.membership && req.membership.role;
  if (!role || !allowedRoles.has(role)) {
    throw new LoadApiError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action} loads.`);
  }
};

const toPublicLoad = (load) => {
  if (!load) return load;
  return load.toObject ? load.toObject() : { ...load };
};

const tenantLoadFilter = (req) => {
  if (req.isDemoMode) return { isDemoData: true };
  return { company: req.companyId, isDemoData: false, ownershipResolved: true };
};

async function findLoadForTenant(req, loadId, { populate = false } = {}) {
  const filter = { _id: loadId, ...tenantLoadFilter(req) };
  let query = Load.findOne(filter);
  if (populate) {
    query = query.populate('assignedCarrier', 'legalName dotNumber mcNumber overallStatus authorityStatus');
  }
  const load = await query;
  if (load) return load;

  const existing = await Load.findById(loadId).select('company isDemoData ownershipResolved');
  if (!existing) {
    throw new LoadApiError(404, 'LOAD_NOT_FOUND', 'Load not found.');
  }
  // Do not leak cross-tenant existence or unresolved legacy record details.
  if (req.isDemoMode) {
    throw new LoadApiError(403, 'FORBIDDEN_TENANT_ACCESS', 'Load is not accessible in demo mode.');
  }
  if (existing.isDemoData) {
    throw new LoadApiError(403, 'FORBIDDEN_TENANT_ACCESS', 'Demo loads cannot be accessed in company context.');
  }
  if (!existing.ownershipResolved || !existing.company) {
    throw new LoadApiError(404, 'LOAD_NOT_FOUND', 'Load not found.');
  }
  if (String(existing.company) !== String(req.companyId)) {
    throw new LoadApiError(403, 'FORBIDDEN_TENANT_ACCESS', 'Load does not belong to the active company.');
  }
  throw new LoadApiError(404, 'LOAD_NOT_FOUND', 'Load not found.');
}

const normalizeLoadBody = (body, { creating = false } = {}) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new LoadApiError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  }
  const forbidden = ['company', 'isDemoData', 'ownershipResolved', 'ownershipResolvedAt', 'ownershipResolution', 'status', 'assignedCarrier', 'assignedAt', 'assignedBy', 'auditSnapshotId', '_id', 'createdAt', 'updatedAt', '__v'];
  const present = forbidden.filter((f) => Object.prototype.hasOwnProperty.call(body, f));
  if (present.length) {
    throw new LoadApiError(400, 'INVALID_FIELDS', `Unsupported or protected fields: ${present.join(', ')}`);
  }
  const payload = { ...body };
  if (creating) {
    // Ensure demo defaults cannot leak into company-mode creates via schema default quirks
    payload.isDemoData = false;
  }
  return payload;
};

async function listLoads(req, query = {}) {
  assertCompanyContext(req, { allowDemo: true });
  if (!req.isDemoMode) assertRole(req, LOAD_READ_ROLES, 'read');

  const filter = tenantLoadFilter(req);
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.equipmentType) filter.equipmentType = String(query.equipmentType).toUpperCase();

  // Pagination keeps list responses bounded: the dispatch board can hold
  // thousands of loads, and an unbounded response would also widen the tenant
  // data surface for a single request.
  const total = await Load.countDocuments(filter);
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const page = Math.max(Number(query.page) || 1, 1);
  const loads = await Load.find(filter)
    .populate('assignedCarrier', 'legalName dotNumber mcNumber')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);
  return {
    success: true,
    count: total,
    loads: loads.map(toPublicLoad),
    pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
  };
}

async function getLoad(req, loadId) {
  assertCompanyContext(req, { allowDemo: true });
  if (!req.isDemoMode) assertRole(req, LOAD_READ_ROLES, 'read');
  if (!mongoose.Types.ObjectId.isValid(String(loadId))) throw new LoadApiError(400, 'INVALID_ID', 'Load ID must be a valid ObjectId.');
  const load = await findLoadForTenant(req, loadId, { populate: true });
  return { success: true, load: toPublicLoad(load) };
}

async function createLoad(req, body) {
  assertCompanyContext(req, { allowDemo: true });
  if (!req.isDemoMode) assertRole(req, LOAD_WRITE_ROLES, 'create');
  const payload = normalizeLoadBody(body, { creating: true });
  if (req.isDemoMode) {
    const load = await Load.create({
      ...payload,
      company: undefined,
      isDemoData: true,
      status: 'POSTED',
      ownershipResolved: true,
      ownershipResolvedAt: new Date(),
      ownershipResolution: 'DEMO'
    });
    return { success: true, load: toPublicLoad(load) };
  }
  const load = await Load.create({
    ...payload,
    company: req.companyId,
    isDemoData: false,
    status: 'POSTED',
    ownershipResolved: true,
    ownershipResolvedAt: new Date(),
    ownershipResolution: 'CREATED'
  });
  return { success: true, load: toPublicLoad(load) };
}

async function updateLoad(req, loadId, body) {
  assertCompanyContext(req, { allowDemo: false });
  assertRole(req, LOAD_WRITE_ROLES, 'update');
  if (!mongoose.Types.ObjectId.isValid(String(loadId))) throw new LoadApiError(400, 'INVALID_ID', 'Load ID must be a valid ObjectId.');
  const load = await findLoadForTenant(req, loadId);
  if (load.status !== 'POSTED') {
    throw new LoadApiError(409, 'LOAD_NOT_EDITABLE', 'Only POSTED loads can be updated.');
  }
  const payload = normalizeLoadBody(body, { creating: false });
  delete payload.loadNumber; // immutable identifier in this flow
  for (const [key, value] of Object.entries(payload)) {
    load.set(key, value);
  }
  await load.save();
  return { success: true, load: toPublicLoad(load) };
}

async function deleteLoad(req, loadId) {
  assertCompanyContext(req, { allowDemo: false });
  assertRole(req, LOAD_WRITE_ROLES, 'delete');
  if (!mongoose.Types.ObjectId.isValid(String(loadId))) throw new LoadApiError(400, 'INVALID_ID', 'Load ID must be a valid ObjectId.');
  const load = await findLoadForTenant(req, loadId);
  if (load.status !== 'POSTED') {
    throw new LoadApiError(409, 'LOAD_NOT_DELETABLE', 'Only POSTED loads can be deleted.');
  }
  await Load.deleteOne({ _id: load._id, company: req.companyId, isDemoData: false, ownershipResolved: true, status: 'POSTED' });
  return { success: true };
}

async function evaluateEligibility(req, loadId, carrierId) {
  assertCompanyContext(req, { allowDemo: true });
  if (!req.isDemoMode) assertRole(req, ELIGIBILITY_ROLES, 'evaluate load eligibility for');
  if (!mongoose.Types.ObjectId.isValid(String(loadId))) throw new LoadApiError(400, 'INVALID_ID', 'Load ID must be a valid ObjectId.');
  if (!mongoose.Types.ObjectId.isValid(String(carrierId))) throw new LoadApiError(400, 'INVALID_ID', 'Carrier ID must be a valid ObjectId.');

  const load = await findLoadForTenant(req, loadId);
  let carrier;
  try {
    carrier = await findCarrierForTenant(req, carrierId);
  } catch (error) {
    if (error instanceof CarrierApiError) throw new LoadApiError(error.status, error.code, error.message);
    throw error;
  }

  // Explicit separation: demo context only demo records (enforced by tenant filters),
  // company context only resolved non-demo same-company records.
  const evaluation = evaluateCarrierForLoad(carrier, load);
  return {
    success: true,
    load: {
      id: load._id,
      loadNumber: load.loadNumber,
      commodity: load.commodity,
      equipmentType: load.equipmentType,
      declaredCargoValue: load.declaredCargoValue,
      targetTemperature: load.targetTemperature
    },
    carrier: {
      id: carrier._id,
      legalName: carrier.legalName,
      dotNumber: carrier.dotNumber,
      mcNumber: carrier.mcNumber
    },
    evaluation
  };
}

async function getLoadAssignment(req, loadId) {
  assertCompanyContext(req, { allowDemo: true });
  if (!req.isDemoMode) assertRole(req, LOAD_READ_ROLES, 'read');
  if (!mongoose.Types.ObjectId.isValid(String(loadId))) throw new LoadApiError(400, 'INVALID_ID', 'Load ID must be a valid ObjectId.');
  const load = await findLoadForTenant(req, loadId, { populate: true });
  if (!load.auditSnapshotId) {
    const rejectedAttempts = await CarrierAssignment.countDocuments({ loadId: load._id, assignmentDecision: 'REJECTED' });
    throw new LoadApiError(404, 'NO_ACTIVE_ASSIGNMENT', 'No active assignment for load ' + load.loadNumber);
  }
  const snapshot = await CarrierAssignment.findById(load.auditSnapshotId);
  if (!snapshot) {
    throw new LoadApiError(500, 'SNAPSHOT_REFERENCE_BROKEN', 'Load references a missing audit snapshot (data integrity failure)');
  }
  const rejectedAttempts = await CarrierAssignment.countDocuments({ loadId: load._id, assignmentDecision: 'REJECTED' });
  return { success: true, loadNumber: load.loadNumber, loadStatus: load.status, rejectedAttempts, snapshot };
}

async function assignLoad(req, loadId, body) {
  assertCompanyContext(req, { allowDemo: true });
  if (!req.isDemoMode) assertRole(req, ASSIGNMENT_ROLES, 'assign');
  if (!mongoose.Types.ObjectId.isValid(String(loadId))) throw new LoadApiError(400, 'INVALID_ID', 'Load ID must be a valid ObjectId.');
  const carrierId = body && body.carrierId;
  if (!mongoose.Types.ObjectId.isValid(String(carrierId || ''))) throw new LoadApiError(400, 'INVALID_ID', 'carrierId must be a valid ObjectId.');
  if (body.overrideReason !== undefined && typeof body.overrideReason !== 'string') {
    throw new LoadApiError(400, 'INVALID_OVERRIDE_REASON', 'overrideReason must be a string');
  }
  if (body.overrideReason) {
    const trimmed = String(body.overrideReason).trim();
    if (trimmed.length > 0 && trimmed.length < 10) {
      throw new LoadApiError(400, 'OVERRIDE_REASON_TOO_SHORT', 'overrideReason must be at least 10 characters when provided');
    }
  }

  const load = await findLoadForTenant(req, loadId);
  let carrier;
  try {
    carrier = await findCarrierForTenant(req, carrierId);
  } catch (error) {
    if (error instanceof CarrierApiError) throw new LoadApiError(error.status, error.code, error.message);
    throw error;
  }
  if (load.status && load.status !== 'POSTED') {
    throw new LoadApiError(409, 'LOAD_NOT_ASSIGNABLE', 'Load ' + load.loadNumber + ' is already ' + load.status + ' and cannot be reassigned via this endpoint');
  }

  const actorRole = req.isDemoMode ? (req.user.role || 'broker') : (req.membership && req.membership.role) || req.user.role;
  return assignCarrierToLoad({
    load,
    carrier,
    actor: { assignedBy: req.user.email, actorRole },
    override: { overrideReason: body.overrideReason, allowOverride: body.allowOverride }
  });
}

// ---------------------------------------------------------------------------
// Load notes (stored as LoadEvent type 'note')
// ---------------------------------------------------------------------------

async function listLoadNotes(req, loadId) {
  const load = await findLoadForTenant(req, loadId);
  const events = await LoadEvent.find({ load: load._id, type: 'note' })
    .sort({ occurredAt: -1 })
    .limit(200);
  return { success: true, count: events.length, notes: events.map((e) => ({
    id: e._id,
    summary: e.summary,
    details: e.details,
    occurredAt: e.occurredAt,
    actor: e.actor,
    actorRole: e.actorRole,
  })) };
}

async function createLoadNote(req, loadId, body) {
  assertCompanyContext(req);
  assertRole(req, LOAD_WRITE_ROLES, 'add load note');
  const load = await findLoadForTenant(req, loadId);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LoadApiError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  if (!body.summary || !String(body.summary).trim()) throw new LoadApiError(400, 'REQUIRED_FIELD', 'Note summary is required');
  const summary = String(body.summary).trim().slice(0, 400);
  const details = body.details && typeof body.details === 'object' ? body.details : undefined;
  const event = await LoadEvent.create({
    company: req.companyId,
    load: load._id,
    type: 'note',
    status: undefined,
    summary,
    details,
    occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
    actor: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    isDemoData: false,
  });
  await auditService.recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'LOAD_NOTE_ADDED',
    entityType: 'Load',
    entityId: load._id,
    summary: 'Load note added: ' + summary,
    metadata: { noteId: String(event._id) },
    isDemoData: false,
  });
  return { success: true, event: { id: event._id, summary: event.summary, details: event.details, occurredAt: event.occurredAt, actor: event.actor, actorRole: event.actorRole } };
}

module.exports = {
  LoadApiError,
  tenantLoadFilter,
  findLoadForTenant,
  listLoads,
  getLoad,
  createLoad,
  updateLoad,
  deleteLoad,
  evaluateEligibility,
  getLoadAssignment,
  assignLoad,
  LOAD_READ_ROLES,
  LOAD_WRITE_ROLES,
  ELIGIBILITY_ROLES,
  ASSIGNMENT_ROLES
};
