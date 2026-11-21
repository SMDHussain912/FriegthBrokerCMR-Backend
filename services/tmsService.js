const mongoose = require('mongoose');
const Load = require('../models/Load');
const Stop = require('../models/Stop');
const LoadEvent = require('../models/LoadEvent');
const Tender = require('../models/Tender');
const Carrier = require('../models/Carrier');
const Customer = require('../models/Customer');
const { recordAuditEvent } = require('./auditService');

class TmsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const WRITE_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'platform_admin']);
const READ_ROLES = new Set([
  'broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer',
  'finance', 'viewer', 'platform_admin', 'platform_support',
]);
const DISPATCH_ROLES = new Set(['broker_owner', 'broker_admin', 'operations_manager', 'platform_admin']);

function assertCompany(req) {
  const explicitDemo = req.headers && req.headers['x-demo-mode'] === 'true';
  const queryDemo = req.query && req.query.demo === 'true';
  if (req.isDemoMode || explicitDemo || queryDemo) {
    throw new TmsError(403, 'DEMO_NOT_ALLOWED', 'This operation is not available in demo mode.');
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new TmsError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertRole(req, allowed, action) {
  const role = req.membership && req.membership.role;
  if (!role || !allowed.has(role)) {
    throw new TmsError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action}.`);
  }
}

function oid(value, label) {
  if (!mongoose.Types.ObjectId.isValid(String(value || ''))) {
    throw new TmsError(400, 'INVALID_ID', `${label} must be a valid ObjectId.`);
  }
}

function ensureBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TmsError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  }
  for (const field of ['company', 'isDemoData', 'createdBy', '_id', 'createdAt', 'updatedAt', '__v']) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      throw new TmsError(400, 'INVALID_FIELDS', `Protected field cannot be set: ${field}`);
    }
  }
}

const tenantFilter = (req) => ({ company: req.companyId, isDemoData: false });

async function findLoad(req, loadId) {
  oid(loadId, 'Load ID');
  const load = await Load.findOne({ _id: loadId, ...tenantFilter(req) });
  if (!load) throw new TmsError(404, 'LOAD_NOT_FOUND', 'Load not found.');
  return load;
}

async function findOwned(Model, req, id, label) {
  oid(id, label);
  const doc = await Model.findOne({ _id: id, ...tenantFilter(req) });
  if (!doc) throw new TmsError(404, 'NOT_FOUND', `${label} not found.`);
  return doc;
}

const audit = (req, action, entityType, entityId, summary, metadata) => recordAuditEvent({
  companyId: req.companyId || null,
  actorId: req.user && req.user.id,
  actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
  action,
  entityType,
  entityId: entityId ? String(entityId) : undefined,
  summary,
  metadata,
  isDemoData: Boolean(req.isDemoMode),
});

// ---------------------------------------------------------------------------
// Stops, appointments and freight details
// ---------------------------------------------------------------------------

const STOP_FIELDS = ['sequence', 'type', 'name', 'address', 'appointmentStart', 'appointmentEnd', 'notes'];

async function listStops(req, loadId) {
  assertCompany(req);
  assertRole(req, READ_ROLES, 'read load stops');
  const load = await findLoad(req, loadId);
  const stops = await Stop.find({ load: load._id, ...tenantFilter(req) }).sort({ sequence: 1 });
  return { success: true, count: stops.length, stops };
}

async function createStop(req, loadId, body) {
  assertCompany(req);
  assertRole(req, WRITE_ROLES, 'manage load stops');
  ensureBody(body);
  const load = await findLoad(req, loadId);
  const sequence = Number.isFinite(Number(body.sequence)) ? Number(body.sequence) : null;
  if (!sequence || sequence < 1) throw new TmsError(400, 'INVALID_SEQUENCE', 'sequence must be a positive number.');
  const duplicate = await Stop.findOne({ load: load._id, sequence, ...tenantFilter(req) });
  if (duplicate) throw new TmsError(409, 'STOP_SEQUENCE_CONFLICT', `A stop with sequence ${sequence} already exists for this load.`);
  const type = ['pickup', 'delivery', 'stop'].includes(body.type) ? body.type : 'pickup';
  const stop = await Stop.create({
    company: req.companyId,
    load: load._id,
    sequence,
    type,
    name: body.name ? String(body.name).trim().slice(0, 200) : undefined,
    address: body.address && typeof body.address === 'object' ? body.address : undefined,
    appointmentStart: body.appointmentStart ? new Date(body.appointmentStart) : undefined,
    appointmentEnd: body.appointmentEnd ? new Date(body.appointmentEnd) : undefined,
    notes: body.notes ? String(body.notes).trim().slice(0, 2000) : undefined,
    isDemoData: false,
  });
  await recordEvent(req, load._id, {
    type: 'stop_added',
    status: stop.status,
    summary: `Stop ${stop.sequence} (${stop.type}) added`,
    details: { stopId: String(stop._id), sequence: stop.sequence, type: stop.type },
  });
  await audit(req, 'LOAD_STOP_ADDED', 'Load', load._id, `Stop ${stop.sequence} added to ${load.loadNumber}`, { stopId: String(stop._id), sequence: stop.sequence });
  return { success: true, stop };
}

async function updateStop(req, stopId, body) {
  assertCompany(req);
  assertRole(req, WRITE_ROLES, 'manage load stops');
  ensureBody(body);
  const stop = await findOwned(Stop, req, stopId, 'Stop');
  const load = await findLoad(req, stop.load);
  if (body.sequence !== undefined) {
    const sequence = Number(body.sequence);
    if (!Number.isFinite(sequence) || sequence < 1) throw new TmsError(400, 'INVALID_SEQUENCE', 'sequence must be a positive number.');
    const clash = await Stop.findOne({ load: load._id, sequence, _id: { $ne: stop._id }, ...tenantFilter(req) });
    if (clash) throw new TmsError(409, 'STOP_SEQUENCE_CONFLICT', `A stop with sequence ${sequence} already exists for this load.`);
    stop.sequence = sequence;
  }
  for (const field of ['type', 'name', 'notes']) {
    if (body[field] !== undefined) stop[field] = body[field];
  }
  if (body.address !== undefined) stop.address = body.address;
  if (body.appointmentStart !== undefined) stop.appointmentStart = body.appointmentStart ? new Date(body.appointmentStart) : null;
  if (body.appointmentEnd !== undefined) stop.appointmentEnd = body.appointmentEnd ? new Date(body.appointmentEnd) : null;
  if (body.type !== undefined && !['pickup', 'delivery', 'stop'].includes(stop.type)) {
    throw new TmsError(400, 'INVALID_STOP_TYPE', 'type must be one of pickup, delivery, stop.');
  }
  await stop.save();
  await audit(req, 'LOAD_STOP_UPDATED', 'Load', load._id, `Stop ${stop.sequence} updated`, { stopId: String(stop._id) });
  return { success: true, stop };
}

const STOP_TRANSITIONS = {
  pending: ['arrived', 'skipped'],
  arrived: ['departed', 'skipped'],
  departed: ['completed'],
  completed: [],
  skipped: [],
};

async function setStopStatus(req, stopId, body) {
  assertCompany(req);
  assertRole(req, DISPATCH_ROLES, 'update stop status');
  ensureBody(body);
  const stop = await findOwned(Stop, req, stopId, 'Stop');
  const load = await findLoad(req, stop.load);
  const next = String(body.status || '');
  const allowed = STOP_TRANSITIONS[stop.status] || [];
  if (!allowed.includes(next)) {
    throw new TmsError(409, 'INVALID_STOP_TRANSITION', `Cannot move stop from ${stop.status} to ${next}.`);
  }
  stop.status = next;
  const now = new Date();
  if (next === 'arrived') stop.arrivedAt = now;
  if (next === 'departed' || next === 'completed') stop.departedAt = now;
  if (body.notes) stop.notes = String(body.notes).trim().slice(0, 2000);
  await stop.save();

  const eventTypes = {
    arrived: 'STOP_ARRIVED',
    departed: 'STOP_DEPARTED',
    completed: 'STOP_COMPLETED',
    skipped: 'STOP_SKIPPED',
  };
  await recordEvent(req, load._id, {
    type: 'milestone',
    status: eventTypes[next],
    summary: `Stop ${stop.sequence} ${next}`,
    details: { stopId: String(stop._id), sequence: stop.sequence, type: stop.type },
  });
  await audit(req, `LOAD_STOP_${next.toUpperCase()}`, 'Load', load._id, `Stop ${stop.sequence} marked ${next}`, { stopId: String(stop._id) });
  return { success: true, stop, loadStatus: load.status };
}

async function deleteStop(req, stopId) {
  assertCompany(req);
  assertRole(req, WRITE_ROLES, 'delete load stops');
  const stop = await findOwned(Stop, req, stopId, 'Stop');
  await findLoad(req, stop.load);
  await Stop.deleteOne({ _id: stop._id, ...tenantFilter(req) });
  await audit(req, 'LOAD_STOP_DELETED', 'Load', stop.load, `Stop ${stop.sequence} deleted`, { stopId: String(stop._id) });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Milestones, exceptions and load activity history
// ---------------------------------------------------------------------------

const EVENT_TYPES = [
  'milestone', 'exception', 'note', 'status_change', 'financial', 'dispatch', 'tender', 'stop_added',
];

async function recordEvent(req, loadId, payload) {
  return LoadEvent.create({
    company: req.companyId,
    load: loadId,
    type: EVENT_TYPES.includes(payload.type) ? payload.type : 'note',
    status: payload.status ? String(payload.status).slice(0, 80) : undefined,
    summary: payload.summary ? String(payload.summary).slice(0, 400) : undefined,
    details: payload.details && typeof payload.details === 'object' ? payload.details : undefined,
    occurredAt: payload.occurredAt ? new Date(payload.occurredAt) : new Date(),
    actor: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    isDemoData: false,
  });
}

async function listEvents(req, loadId, query = {}) {
  assertCompany(req);
  assertRole(req, READ_ROLES, 'read load activity');
  const load = await findLoad(req, loadId);
  const filter = { load: load._id, ...tenantFilter(req) };
  if (query.type) filter.type = String(query.type);
  const events = await LoadEvent.find(filter).sort({ occurredAt: -1 }).limit(200);
  return { success: true, count: events.length, events };
}

async function createEvent(req, loadId, body) {
  assertCompany(req);
  assertRole(req, WRITE_ROLES, 'log load activity');
  ensureBody(body);
  const load = await findLoad(req, loadId);
  const type = EVENT_TYPES.includes(body.type) ? body.type : 'note';
  if (!body.summary && !body.details) throw new TmsError(400, 'EVENT_CONTENT_REQUIRED', 'summary or details is required.');
  const event = await recordEvent(req, load._id, {
    type,
    status: body.status,
    summary: body.summary,
    details: body.details,
    occurredAt: body.occurredAt,
  });
  await audit(req, `LOAD_EVENT_${type.replace(/_/g, '_')}`, 'Load', load._id, body.summary || `Load event logged (${type})`, { eventId: String(event._id), type });
  return { success: true, event };
}

async function updateLoadStatus(req, loadId, body) {
  assertCompany(req);
  assertRole(req, DISPATCH_ROLES, 'update load status');
  ensureBody(body);
  const load = await findLoad(req, loadId);
  const next = String(body.status || '').toUpperCase();
  const allowed = ['POSTED', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'];
  if (!allowed.includes(next)) throw new TmsError(400, 'INVALID_STATUS', `status must be one of ${allowed.join(', ')}.`);
  const from = load.status;
  load.status = next;
  await load.save();
  await recordEvent(req, load._id, {
    type: 'status_change',
    status: next,
    summary: `Load status changed from ${from} to ${next}`,
    details: { from, to: next, reason: body.reason ? String(body.reason).slice(0, 500) : undefined },
  });
  await audit(req, 'LOAD_STATUS_CHANGED', 'Load', load._id, `Load status ${from} -> ${next}`, { from, to: next });
  return { success: true, load };
}

// ---------------------------------------------------------------------------
// Carrier matching and tendering
// ---------------------------------------------------------------------------

async function listTenders(req, loadId) {
  assertCompany(req);
  assertRole(req, READ_ROLES, 'read tenders');
  const load = await findLoad(req, loadId);
  const tenders = await Tender.find({ load: load._id, ...tenantFilter(req) })
    .populate('carrier', 'legalName dotNumber mcNumber overallStatus authorityStatus')
    .sort({ createdAt: -1 });
  return { success: true, count: tenders.length, tenders };
}

async function createTender(req, loadId, body) {
  assertCompany(req);
  assertRole(req, WRITE_ROLES, 'tender loads');
  ensureBody(body);
  const load = await findLoad(req, loadId);
  const carrierId = body.carrierId;
  oid(carrierId, 'carrierId');
  const carrier = await Carrier.findOne({ _id: carrierId, ...tenantFilter(req) });
  if (!carrier) throw new TmsError(404, 'CARRIER_NOT_FOUND', 'Carrier not found for the active company.');
  if (load.status !== 'POSTED') {
    throw new TmsError(409, 'LOAD_NOT_TENDERABLE', `Only POSTED loads can be tendered (load is ${load.status}).`);
  }
  const open = await Tender.findOne({ load: load._id, carrier: carrier._id, status: 'tendered', ...tenantFilter(req) });
  if (open) throw new TmsError(409, 'TENDER_ALREADY_OPEN', 'An open tender already exists for this load and carrier.');
  const tender = await Tender.create({
    company: req.companyId,
    load: load._id,
    carrier: carrier._id,
    status: 'tendered',
    rateOffered: body.rateOffered !== undefined ? Number(body.rateOffered) : undefined,
    currency: body.currency ? String(body.currency).slice(0, 8) : 'USD',
    notes: body.notes ? String(body.notes).trim().slice(0, 2000) : undefined,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    createdBy: req.user && req.user.id,
    isDemoData: false,
  });
  await recordEvent(req, load._id, {
    type: 'tender',
    status: 'tendered',
    summary: `Load tendered to ${carrier.legalName}`,
    details: { tenderId: String(tender._id), carrierId: String(carrier._id) },
  });
  await audit(req, 'LOAD_TENDERED', 'Load', load._id, `Load ${load.loadNumber} tendered to ${carrier.legalName}`, {
    tenderId: String(tender._id), carrierId: String(carrier._id),
  });
  return { success: true, tender };
}

async function updateTenderStatus(req, tenderId, body) {
  assertCompany(req);
  assertRole(req, WRITE_ROLES, 'update tenders');
  ensureBody(body);
  const tender = await findOwned(Tender, req, tenderId, 'Tender');
  const load = await findLoad(req, tender.load);
  const next = String(body.status || '');
  const allowed = ['accepted', 'rejected', 'cancelled', 'expired'];
  if (!allowed.includes(next)) throw new TmsError(400, 'INVALID_TENDER_STATUS', `status must be one of ${allowed.join(', ')}.`);
  if (!['tendered'].includes(tender.status)) {
    throw new TmsError(409, 'TENDER_NOT_OPEN', `Tender is already ${tender.status}.`);
  }
  if (next === 'accepted' && load.status !== 'POSTED') {
    throw new TmsError(409, 'LOAD_NOT_ASSIGNABLE', `Load ${load.loadNumber} is already ${load.status} and cannot be awarded.`);
  }
  tender.status = next;
  tender.respondedAt = new Date();
  await tender.save();

  // Awarding a tender is the dispatch decision: the load moves to ASSIGNED and
  // the carrier is recorded with the same fields the explicit assign path uses,
  // so downstream dispatch and eligibility views see one consistent shape.
  if (next === 'accepted') {
    load.status = 'ASSIGNED';
    load.assignedCarrier = tender.carrier;
    load.assignedAt = new Date();
    load.assignedBy = req.user && req.user.id;
    await load.save();
  }

  await recordEvent(req, load._id, {
    type: 'tender',
    status: next,
    summary: next === 'accepted'
      ? `Tender accepted; load assigned to carrier`
      : `Tender ${next}`,
    details: { tenderId: String(tender._id), carrierId: String(tender.carrier) },
  });

  if (next === 'accepted') {
    // Canonical assignment audit event: tender acceptance and explicit assign
    // both transition the load to ASSIGNED with a carrier. Emit LOAD_ASSIGNED
    // (with via: 'tender' metadata) so downstream consumers listen to one event.
    await audit(req, 'LOAD_ASSIGNED', 'Load', load._id, `Tender accepted; load ${load.loadNumber} assigned to carrier`, {
      via: 'tender', tenderId: String(tender._id), carrierId: String(tender.carrier),
    });
  } else {
    await audit(req, `LOAD_TENDER_${next.toUpperCase()}`, 'Load', load._id, `Tender ${next} for load ${load.loadNumber}`, {
      tenderId: String(tender._id), carrierId: String(tender.carrier),
    });
  }
  return { success: true, tender };
}

// ---------------------------------------------------------------------------
// Load costs, customer rates and margins
// ---------------------------------------------------------------------------

const FINANCIAL_FIELDS = ['customerRate', 'carrierCost', 'currency', 'accessorials', 'notes'];

function marginFor(load) {
  const customerRate = Number(load.customerRate || 0);
  const carrierCost = Number(load.carrierCost || 0);
  const accessorials = Number(load.accessorials || 0);
  const revenue = customerRate + accessorials;
  const margin = revenue - carrierCost;
  const marginPct = revenue > 0 ? Number(((margin / revenue) * 100).toFixed(2)) : 0;
  return { customerRate, carrierCost, accessorials, revenue, margin, marginPct, currency: load.currency || 'USD' };
}

async function getFinancials(req, loadId) {
  assertCompany(req);
  assertRole(req, READ_ROLES, 'read load financials');
  const load = await findLoad(req, loadId);
  return { success: true, load: { id: load._id, loadNumber: load.loadNumber, status: load.status }, financials: marginFor(load) };
}

async function updateFinancials(req, loadId, body) {
  assertCompany(req);
  assertRole(req, new Set(['broker_owner', 'broker_admin', 'finance', 'operations_manager', 'platform_admin']), 'update load financials');
  ensureBody(body);
  const load = await findLoad(req, loadId);
  for (const field of FINANCIAL_FIELDS) {
    if (body[field] === undefined) continue;
    if (field === 'currency') {
      load.currency = String(body[field]).slice(0, 8).toUpperCase();
    } else if (field === 'notes') {
      load.notes = String(body[field]).slice(0, 2000);
    } else {
      const value = Number(body[field]);
      if (!Number.isFinite(value) || value < 0) {
        throw new TmsError(400, 'INVALID_AMOUNT', `${field} must be a non-negative number.`);
      }
      load[field] = value;
    }
  }
  await load.save();
  const financials = marginFor(load);
  await recordEvent(req, load._id, {
    type: 'financial',
    summary: `Financials updated: revenue ${financials.revenue} ${financials.currency}, margin ${financials.margin}`,
    details: financials,
  });
  await audit(req, 'LOAD_FINANCIALS_UPDATED', 'Load', load._id, `Financials updated for ${load.loadNumber}`, financials);
  return { success: true, financials };
}

// ---------------------------------------------------------------------------
// Operational exception queue
// ---------------------------------------------------------------------------

/**
 * Loads that need dispatch attention.
 *
 * Sources, in priority order:
 *   1. unacknowledged `exception` events (severity high/medium, newest first),
 *   2. loads still POSTED past their requested pickup window (never tendered).
 *
 * Each row carries a machine-readable `reason` so a triage view never has to
 * re-derive why the load surfaced. Scoped to the verified company.
 */
async function listExceptions(req, query = {}) {
  assertCompany(req);
  assertRole(req, READ_ROLES, 'read exception queue');

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [exceptionEvents, postedLoads] = await Promise.all([
    LoadEvent.find({
      ...tenantFilter(req),
      type: 'exception',
      occurredAt: { $gte: since },
      acknowledgedAt: { $exists: false },
    })
      .populate('load', 'loadNumber status customerRate carrierCost pickupDate')
      .sort({ occurredAt: -1 })
      .limit(100),
    Load.find({
      ...tenantFilter(req),
      status: 'POSTED',
      'origin.pickupDate': { $lt: new Date() },
    })
      .sort({ pickupDate: 1 })
      .limit(100),
  ]);

  const rows = [];
  for (const event of exceptionEvents) {
    const load = event.load;
    if (!load) continue;
    rows.push({
      id: String(event._id),
      kind: 'exception',
      reason: 'exception',
      reasonLabel: event.details && event.details.severity ? `Exception (${event.details.severity})` : 'Exception reported',
      loadId: String(load._id),
      loadNumber: load.loadNumber,
      status: load.status,
      summary: event.summary,
      occurredAt: event.occurredAt,
      severity: (event.details && event.details.severity) || 'medium',
    });
  }
  for (const load of postedLoads) {
    rows.push({
      id: `late:${load._id}`,
      kind: 'late_pickup',
      reason: 'late_pickup',
      reasonLabel: 'Pickup window passed, still posted',
      loadId: String(load._id),
      loadNumber: load.loadNumber,
      status: load.status,
      summary: `Pickup ${load.origin && load.origin.pickupDate ? new Date(load.origin.pickupDate).toISOString() : 'unscheduled'} has passed without a tender`,
      occurredAt: (load.origin && load.origin.pickupDate) || load.createdAt,
      severity: 'high',
    });
  }

  rows.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  return {
    success: true,
    count: rows.length,
    exceptions: rows.slice(0, Number(query.limit) > 0 ? Math.min(Number(query.limit), 200) : rows.length),
  };
}

// ---------------------------------------------------------------------------
// Proof of delivery — captured at the moment of delivery confirmation.
// ---------------------------------------------------------------------------

async function confirmDelivery(req, loadId, body) {
  assertCompany(req);
  assertRole(req, DISPATCH_ROLES, 'confirm load delivery');
  ensureBody(body);
  const load = await findLoad(req, loadId);

  if (load.status !== 'DELIVERED') {
    throw new TmsError(409, 'INVALID_LOAD_STATUS', `Cannot confirm delivery for a load with status ${load.status}. Load must be DELIVERED.`);
  }
  if (load.deliveryProof && load.deliveryProof.confirmedAt) {
    throw new TmsError(409, 'DELIVERY_ALREADY_CONFIRMED', 'Delivery has already been confirmed for this load.');
  }

  const now = new Date();
  const actorEmail = req.user && req.user.email;
  const actorRole = (req.membership && req.membership.role) || (req.user && req.user.role);

  const proof = {
    confirmedAt: now,
    confirmedBy: actorEmail,
    confirmedByRole: actorRole,
    signedBy: body.signedBy ? String(body.signedBy).trim().slice(0, 200) : undefined,
    notes: body.notes ? String(body.notes).trim().slice(0, 2000) : undefined,
    documentUri: body.documentUri ? String(body.documentUri).trim().slice(0, 500) : undefined,
    conditionAtDelivery: body.conditionAtDelivery ? String(body.conditionAtDelivery).trim().slice(0, 200) : undefined,
  };
  load.deliveryProof = proof;
  await load.save();

  await recordEvent(req, load._id, {
    type: 'milestone',
    status: 'DELIVERY_CONFIRMED',
    summary: `Delivery confirmed for load ${load.loadNumber}`,
    details: {
      confirmedAt: now.toISOString(),
      confirmedBy: actorEmail,
      signedBy: proof.signedBy,
      conditionAtDelivery: proof.conditionAtDelivery,
    },
  });
  await audit(req, 'LOAD_DELIVERY_CONFIRMED', 'Load', load._id, `Delivery confirmed for load ${load.loadNumber}`, {
    confirmedAt: now.toISOString(),
    signedBy: proof.signedBy,
    conditionAtDelivery: proof.conditionAtDelivery,
  });

  return { success: true, load: load.toObject() };
}

async function getDeliveryProof(req, loadId) {
  assertCompany(req);
  assertRole(req, READ_ROLES, 'read delivery proof');
  const load = await findLoad(req, loadId);
  return { success: true, deliveryProof: load.deliveryProof || null, loadStatus: load.status };
}

// ---------------------------------------------------------------------------
// Activity history (customer + carrier) and reporting
// ---------------------------------------------------------------------------

async function activityHistory(req, query = {}) {
  assertCompany(req);
  assertRole(req, READ_ROLES, 'read activity history');
  const filter = tenantFilter(req);
  if (query.loadId) filter.load = query.loadId;
  const events = await LoadEvent.find(filter)
    .populate('load', 'loadNumber status')
    .sort({ occurredAt: -1 })
    .limit(200);
  return { success: true, count: events.length, events };
}

async function dashboard(req) {
  assertCompany(req);
  assertRole(req, READ_ROLES, 'read operational dashboard');
  const filter = tenantFilter(req);
  const [loads, loadsByStatus, tenders, stops, customerCount] = await Promise.all([
    Load.find(filter).select('status customerRate carrierCost accessorials currency assignedCarrier createdAt'),
    Load.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Tender.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Stop.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Customer.countDocuments(filter),
  ]);

  let revenue = 0;
  let cost = 0;
  for (const load of loads) {
    revenue += Number(load.customerRate || 0) + Number(load.accessorials || 0);
    cost += Number(load.carrierCost || 0);
  }
  const margin = revenue - cost;

  return {
    success: true,
    summary: {
      totalLoads: loads.length,
      customers: customerCount,
      revenue: Number(revenue.toFixed(2)),
      cost: Number(cost.toFixed(2)),
      margin: Number(margin.toFixed(2)),
      marginPct: revenue > 0 ? Number(((margin / revenue) * 100).toFixed(2)) : 0,
      loadsByStatus: loadsByStatus.map((row) => ({ status: row._id, count: row.count })),
      tendersByStatus: tenders.map((row) => ({ status: row._id, count: row.count })),
      stopsByStatus: stops.map((row) => ({ status: row._id, count: row.count })),
    },
  };
}

async function reportLoads(req, query = {}) {
  assertCompany(req);
  assertRole(req, READ_ROLES, 'read load reports');
  const filter = tenantFilter(req);
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }
  const loads = await Load.find(filter).select('loadNumber status customerRate carrierCost accessorials currency createdAt');
  let revenue = 0;
  let cost = 0;
  for (const load of loads) {
    revenue += Number(load.customerRate || 0) + Number(load.accessorials || 0);
    cost += Number(load.carrierCost || 0);
  }
  return {
    success: true,
    count: loads.length,
    totals: {
      revenue: Number(revenue.toFixed(2)),
      cost: Number(cost.toFixed(2)),
      margin: Number((revenue - cost).toFixed(2)),
      marginPct: revenue > 0 ? Number((((revenue - cost) / revenue) * 100).toFixed(2)) : 0,
    },
    loads,
  };
}

module.exports = {
  TmsError,
  listStops, createStop, updateStop, setStopStatus, deleteStop,
  listEvents, createEvent, updateLoadStatus,
  listTenders, createTender, updateTenderStatus,
  getFinancials, updateFinancials, marginFor,
  activityHistory, dashboard, reportLoads, listExceptions,
  confirmDelivery, getDeliveryProof,
  recordEvent,
  WRITE_ROLES, READ_ROLES, DISPATCH_ROLES,
};