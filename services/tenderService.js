const mongoose = require('mongoose');
const Tender = require('../models/Tender');
const Load = require('../models/Load');
const Carrier = require('../models/Carrier');
const NumberSequence = require('../models/NumberSequence');
const { recordAuditEvent } = require('./auditService');
const { withTransaction } = require('./transactionHelper');

/**
 * Tender Service - Complete tender lifecycle management
 */

const TENDER_EXPIRY_HOURS = 24;

/**
 * Send tender to carrier
 */
async function sendTender(params) {
  return withTransaction(async (session) => {
    const { loadId, carrierId, offeredRate, offeredRatePerMile, expiresInHours = TENDER_EXPIRY_HOURS, idempotencyKey, sentBy, companyId, isDemoData = false } = params;
    const load = await Load.findById(loadId).session(session);
    if (!load) throw new Error('Load not found');
    if (load.status !== 'POSTED') throw new Error(`Load is not available for tender (status: ${load.status})`);
    const carrier = await Carrier.findById(carrierId).session(session);
    if (!carrier) throw new Error('Carrier not found');
    const existing = await Tender.findOne({ load: loadId, carrier: carrierId, status: { $in: ['SENT', 'VIEWED', 'COUNTERED'] } }).session(session);
    if (existing) throw new Error('Active tender already exists for this carrier');
    const tenderNumber = await NumberSequence.getNextNumber(companyId, 'Tender', isDemoData);
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    const tender = await Tender.create([{ company: companyId, load: loadId, loadNumber: load.loadNumber, carrier: carrierId, carrierName: carrier.legalName, tenderNumber, offeredRate, offeredRatePerMile, expiresAt, sentBy, createdBy: sentBy, isDemoData, idempotencyKey }], { session });
    await recordAuditEvent({ action: 'TENDER_SENT', entityType: 'Tender', entityId: tender[0]._id, companyId, actor: { id: sentBy }, summary: `Tender ${tenderNumber} sent to ${carrier.legalName} for load ${load.loadNumber}`, severity: 'info', metadata: { offeredRate, expiresAt } }, { session });
    return tender[0];
  });
}

/**
 * Get tender by ID with tenant isolation
 */
async function getTender(params) {
  const { tenderId, companyId } = params;
  const tender = await Tender.findOne({ _id: tenderId, company: companyId }).populate('load', 'loadNumber status').populate('carrier', 'legalName dotNumber mcNumber overallStatus');
  if (!tender) throw new Error('Tender not found');
  return tender;
}

/**
 * List tenders with filters
 */
async function listTenders(params) {
  const { companyId, status, carrierId, loadId, limit = 50, skip = 0, sort = '-sentAt' } = params;
  const filter = { company: companyId };
  if (status) filter.status = status;
  if (carrierId) filter.carrier = carrierId;
  if (loadId) filter.load = loadId;
  const [tenders, total] = await Promise.all([Tender.find(filter).populate('load', 'loadNumber status origin destination').populate('carrier', 'legalName dotNumber mcNumber overallStatus').sort(sort).skip(skip).limit(limit), Tender.countDocuments(filter)]);
  return { tenders, total, limit, skip };
}

/**
 * Carrier views tender
 */
async function viewTender(params) {
  return withTransaction(async (session) => {
    const { tenderId, companyId, userId } = params;
    const tender = await Tender.findOne({ _id: tenderId, company: companyId }).session(session);
    if (!tender) throw new Error('Tender not found');
    tender.markViewed(userId);
    await tender.save({ session });
    await recordAuditEvent({ action: 'TENDER_VIEWED', entityType: 'Tender', entityId: tender._id, companyId, actor: { id: userId }, summary: `Tender ${tender.tenderNumber} viewed by carrier`, severity: 'info' }, { session });
    return tender;
  });
}

/**
 * Carrier accepts tender
 */
async function acceptTender(params) {
  return withTransaction(async (session) => {
    const { tenderId, companyId, userId, notes = '' } = params;
    const tender = await Tender.findOne({ _id: tenderId, company: companyId }).session(session);
    if (!tender) throw new Error('Tender not found');
    tender.accept(userId, notes);
    await tender.save({ session });
    const load = await Load.findById(tender.load).session(session);
    if (load) { load.status = 'ASSIGNED'; load.assignedCarrier = tender.carrier; load.assignedAt = new Date(); load.assignedBy = String(userId); await load.save({ session }); }
    await recordAuditEvent({ action: 'TENDER_ACCEPTED', entityType: 'Tender', entityId: tender._id, companyId, actor: { id: userId }, summary: `Tender ${tender.tenderNumber} accepted by carrier`, severity: 'info', metadata: { notes } }, { session });
    const { assignCarrierToLoad } = require('./assignmentService');
    const carrier = await Carrier.findById(tender.carrier).session(session);
    const assignmentResult = await assignCarrierToLoad({ load, carrier, actor: { assignedBy: String(userId), actorRole: 'carrier' }, loadModel: Load, assignmentModel: mongoose.model('CarrierAssignment') }, { session });
    return { tender, assignment: assignmentResult };
  });
}

/**
 * Carrier rejects tender
 */
async function rejectTender(params) {
  return withTransaction(async (session) => {
    const { tenderId, companyId, userId, reason = '' } = params;
    const tender = await Tender.findOne({ _id: tenderId, company: companyId }).session(session);
    if (!tender) throw new Error('Tender not found');
    tender.reject(userId, reason);
    await tender.save({ session });
    await recordAuditEvent({ action: 'TENDER_REJECTED', entityType: 'Tender', entityId: tender._id, companyId, actor: { id: userId }, summary: `Tender ${tender.tenderNumber} rejected by carrier`, severity: 'info', metadata: { reason } }, { session });
    return tender;
  });
}

/**
 * Carrier counters tender
 */
async function counterTender(params) {
  return withTransaction(async (session) => {
    const { tenderId, companyId, userId, rate, reason = '' } = params;
    const tender = await Tender.findOne({ _id: tenderId, company: companyId }).session(session);
    if (!tender) throw new Error('Tender not found');
    tender.counter(userId, rate, reason);
    await tender.save({ session });
    await recordAuditEvent({ action: 'TENDER_COUNTERED', entityType: 'Tender', entityId: tender._id, companyId, actor: { id: userId }, summary: `Tender ${tender.tenderNumber} countered by carrier`, severity: 'info', metadata: { counterRate: rate, reason } }, { session });
    return tender;
  });
}

/**
 * Broker withdraws tender
 */
async function withdrawTender(params) {
  return withTransaction(async (session) => {
    const { tenderId, companyId, userId } = params;
    const tender = await Tender.findOne({ _id: tenderId, company: companyId }).session(session);
    if (!tender) throw new Error('Tender not found');
    tender.withdraw(userId);
    await tender.save({ session });
    await recordAuditEvent({ action: 'TENDER_WITHDRAWN', entityType: 'Tender', entityId: tender._id, companyId, actor: { id: userId }, summary: `Tender ${tender.tenderNumber} withdrawn by broker`, severity: 'info' }, { session });
    return tender;
  });
}

/**
 * Broker accepts carrier counter-offer
 */
async function acceptCounter(params) {
  return withTransaction(async (session) => {
    const { tenderId, companyId, userId } = params;
    const tender = await Tender.findOne({ _id: tenderId, company: companyId }).session(session);
    if (!tender) throw new Error('Tender not found');
    if (tender.status !== 'COUNTERED') throw new Error('Tender is not in countered state');
    tender.status = 'ACCEPTED';
    tender.offeredRate = tender.counterRate;
    tender.offeredRatePerMile = tender.counterRatePerMile;
    tender.respondedAt = new Date();
    tender.respondedBy = userId;
    tender.acceptanceNotes = 'Counter-offer accepted by broker';
    await tender.save({ session });
    const load = await Load.findById(tender.load).session(session);
    if (load) { load.status = 'ASSIGNED'; load.assignedCarrier = tender.carrier; load.assignedAt = new Date(); load.assignedBy = String(userId); load.carrierCost = tender.counterRate; await load.save({ session }); }
    await recordAuditEvent({ action: 'TENDER_COUNTER_ACCEPTED', entityType: 'Tender', entityId: tender._id, companyId, actor: { id: userId }, summary: `Counter-offer accepted for tender ${tender.tenderNumber}`, severity: 'info', metadata: { counterRate: tender.counterRate } }, { session });
    const { assignCarrierToLoad } = require('./assignmentService');
    const carrier = await Carrier.findById(tender.carrier).session(session);
    const assignmentResult = await assignCarrierToLoad({ load, carrier, actor: { assignedBy: String(userId), actorRole: 'broker' }, loadModel: Load, assignmentModel: mongoose.model('CarrierAssignment') }, { session });
    return { tender, assignment: assignmentResult };
  });
}

/**
 * Expire old tenders (scheduled job)
 */
async function expireOldTenders() {
  const now = new Date();
  const result = await Tender.updateMany({ status: { $in: ['SENT', 'VIEWED'] }, expiresAt: { $lt: now } }, { $set: { status: 'EXPIRED' } });
  return result.modifiedCount;
}

/**
 * Get tender statistics for a company
 */
async function getTenderStats(companyId) {
  const stats = await Tender.aggregate([{ $match: { company: companyId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
  const byStatus = {}; for (const s of stats) byStatus[s._id] = s.count;
  const avgResponseTime = await Tender.aggregate([{ $match: { company: companyId, status: { $in: ['ACCEPTED', 'REJECTED'] }, respondedAt: { $exists: true } } }, { $project: { responseHours: { $divide: [{ $subtract: ['$respondedAt', '$sentAt'] }, 1000 * 60 * 60] } } }, { $group: { _id: null, avgHours: { $avg: '$responseHours' } } }]);
  return { byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0), avgResponseHours: avgResponseTime[0]?.avgHours || 0 };
}

module.exports = { sendTender, getTender, listTenders, viewTender, acceptTender, rejectTender, counterTender, withdrawTender, acceptCounter, expireOldTenders, getTenderStats };
