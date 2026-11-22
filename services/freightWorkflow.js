const mongoose = require('mongoose');
const Load = require('../models/Load');
const Carrier = require('../models/Carrier');
const LoadEvent = require('../models/LoadEvent');
const Invoice = require('../models/Invoice');
const Payable = require('../models/Payable');
const CreditNote = require('../models/CreditNote');
const NumberSequence = require('../models/NumberSequence');
const { recordAuditEvent } = require('./auditService');
const { withTransaction, FinancialPatterns } = require('./transactionHelper');
const { sendTender, acceptTender, rejectTender, counterTender, withdrawTender, acceptCounter } = require('./tenderService');
const { createInvoice, recordInvoicePayment } = require('./financialService');
const { createPayable, recordPayablePayment } = require('./financialService');

/**
 * Freight Workflow Service - Complete end-to-end freight lifecycle
 * 
 * Workflow: Quote -> Rate Agreement -> Load Creation -> Carrier Matching -> Tender -> 
 * Acceptance -> Dispatch -> Pickup -> In Transit -> Delivery -> POD -> 
 * Invoice -> Carrier Payable -> Payment -> Reconciliation
 */

// Load status enum
const LOAD_STATUSES = [
  'POSTED',      // Available for carrier assignment
  'TENDERED',    // Tender sent to carrier(s)
  'ASSIGNED',    // Carrier accepted, not yet dispatched
  'DISPATCHED',  // Carrier dispatched, en route to pickup
  'PICKED_UP',   // Freight picked up
  'IN_TRANSIT',  // En route to delivery
  'DELIVERED',   // Delivered, POD pending
  'POD_RECEIVED', // Proof of delivery received
  'INVOICED',    // Customer invoiced
  'PAID',        // Customer paid
  'RECONCILED',  // Fully reconciled
  'CANCELLED',   // Cancelled
  'EXCEPTION'    // Exception/issue
];

/**
 * Create load with full validation
 * @param {Object} params - Load parameters
 * @returns {Promise<Object>} Created load
 */
async function createLoad(params) {
  return withTransaction(async (session) => {
    const { companyId, userId, loadData, isDemoData = false } = params;
    
    // Generate load number
    const loadNumber = await NumberSequence.getNextNumber(companyId, 'Load', isDemoData);
    
    // Calculate margin
    const customerRate = loadData.customerRate || 0;
    const carrierCost = loadData.carrierCost || 0;
    const accessorials = loadData.accessorials || 0;
    const margin = customerRate - carrierCost - accessorials;
    const marginPercent = customerRate > 0 ? ((margin / customerRate) * 100).toFixed(2) : 0;
    
    // Set initial status
    const status = 'POSTED';
    
    // Create load
    const load = await Load.create([{
      company: companyId,
      loadNumber,
      ...loadData,
      customerRate,
      carrierCost,
      accessorials,
      margin,
      marginPercent,
      status,
      createdBy: userId,
      updatedBy: userId,
      isDemoData
    }], { session });
    
    // Create initial load event
    await LoadEvent.create([{
      company: companyId,
      load: load[0]._id,
      type: 'created',
      status: 'POSTED',
      summary: `Load ${loadNumber} created`,
      occurredAt: new Date(),
      actor: userId,
      actorRole: 'broker',
      isDemoData
    }], { session });
    
    await recordAuditEvent({ action: 'LOAD_CREATED', entityType: 'Load', entityId: load[0]._id, companyId, actor: { id: userId }, summary: `Load ${loadNumber} created`, severity: 'info', metadata: { customerRate, carrierCost, margin } }, { session });
    
    return load[0];
  });
}

/**
 * Send tender to carrier
 */
async function sendTenderToCarrier(params) {
  return withTransaction(async (session) => {
    const { loadId, carrierId, offeredRate, offeredRatePerMile, companyId, userId, isDemoData = false } = params;
    
    const load = await Load.findById(loadId).session(session);
    if (!load) throw new Error('Load not found');
    if (load.status !== 'POSTED') throw new Error(`Load not available for tender (status: ${load.status})`);
    
    const carrier = await Carrier.findById(carrierId).session(session);
    if (!carrier) throw new Error('Carrier not found');
    
    const result = await sendTender({ loadId, carrierId, offeredRate, offeredRatePerMile, companyId, sentBy: userId, isDemoData });
    
    // Update load status
    load.status = 'TENDERED';
    load.updatedBy = userId;
    await load.save({ session });
    
    await LoadEvent.create([{ company: companyId, load: load._id, type: 'tendered', status: 'TENDERED', summary: `Tender sent to ${carrier.legalName}`, occurredAt: new Date(), actor: userId, actorRole: 'broker', isDemoData }], { session });
    
    await recordAuditEvent({ action: 'TENDER_SENT_TO_CARRIER', entityType: 'Load', entityId: load._id, companyId, actor: { id: userId }, summary: `Tender sent to ${carrier.legalName}`, severity: 'info', metadata: { carrierId, offeredRate } }, { session });
    
    return { tender: result, load };
  });
}

/**
 * Update load status with event logging
 * @param {Object} params - Status update parameters
 * @returns {Promise<Object>} Updated load
 */
async function updateLoadStatus(params) {
  return withTransaction(async (session) => {
    const { loadId, newStatus, userId, notes, documentUri, conditionAtDelivery, companyId, isDemoData = false } = params;
    
    if (!LOAD_STATUSES.includes(newStatus)) {
      throw new Error(`Invalid status: ${newStatus}`);
    }
    
    const load = await Load.findById(loadId).session(session);
    if (!load) throw new Error('Load not found');
    
    const oldStatus = load.status;
    
    // Validate status transitions
    const validTransitions = {
      POSTED: ['TENDERED', 'ASSIGNED', 'CANCELLED'],
      TENDERED: ['ASSIGNED', 'POSTED', 'CANCELLED'],
      ASSIGNED: ['DISPATCHED', 'POSTED', 'CANCELLED'],
      DISPATCHED: ['PICKED_UP', 'ASSIGNED', 'CANCELLED'],
      PICKED_UP: ['IN_TRANSIT', 'CANCELLED'],
      IN_TRANSIT: ['DELIVERED', 'EXCEPTION', 'CANCELLED'],
      DELIVERED: ['POD_RECEIVED', 'EXCEPTION'],
      POD_RECEIVED: ['INVOICED', 'EXCEPTION'],
      INVOICED: ['PAID', 'EXCEPTION'],
      PAID: ['RECONCILED', 'EXCEPTION'],
      RECONCILED: [],
      CANCELLED: [],
      EXCEPTION: ['POSTED', 'ASSIGNED', 'DISPATCHED', 'IN_TRANSIT']
    };
    
    if (!validTransitions[oldStatus]?.includes(newStatus)) {
      throw new Error(`Invalid status transition: ${oldStatus} -> ${newStatus}`);
    }
    
    // Update load
    load.status = newStatus;
    load.updatedBy = userId;
    
    // Handle special status fields
    if (newStatus === 'PICKED_UP') {
      load.pickupConfirmedAt = new Date();
      load.pickupConfirmedBy = userId;
    } else if (newStatus === 'DELIVERED') {
      load.deliveryConfirmedAt = new Date();
      load.deliveryConfirmedBy = userId;
    } else if (newStatus === 'POD_RECEIVED') {
      load.deliveryProof = {
        ...load.deliveryProof,
        confirmedAt: new Date(),
        confirmedBy: String(userId),
        confirmedByRole: 'broker',
        documentUri,
        conditionAtDelivery
      };
    }
    
    await load.save({ session });
    
    // Create load event
    await LoadEvent.create([{
      company: companyId,
      load: load._id,
      type: 'status_change',
      status: newStatus,
      summary: `Status changed: ${oldStatus} -> ${newStatus}${notes ? ': ' + notes : ''}`,
      details: { oldStatus, newStatus, notes },
      occurredAt: new Date(),
      actor: userId,
      actorRole: 'broker',
      isDemoData
    }], { session });
    
    await recordAuditEvent({ action: 'LOAD_STATUS_CHANGED', entityType: 'Load', entityId: load._id, companyId, actor: { id: userId }, summary: `Load ${load.loadNumber} status: ${oldStatus} -> ${newStatus}`, severity: 'info', metadata: { oldStatus, newStatus, notes } }, { session });
    
    // Auto-trigger next steps
    if (newStatus === 'POD_RECEIVED') {
      // Auto-create invoice and payable
      await autoCreateFinancials(load, userId, companyId, isDemoData, session);
    }
    
    return load;
  });
}

/**
 * Auto-create invoice and payable after POD
 */
async function autoCreateFinancials(load, userId, companyId, isDemoData, session) {
  try {
    // Create invoice for customer
    const invoiceResult = await createInvoice({
      company: companyId,
      customer: load.customer,
      lineItems: [{
        description: `Freight: ${load.loadNumber} - ${load.commodity}`,
        quantity: 1,
        unitPrice: load.customerRate
      }],
      currency: load.currency,
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Net 30
      notes: `Load ${load.loadNumber}`,
      linkedLoads: [load._id],
      createdBy: userId,
      isDemoData
    }, session);
    
    // Create payable for carrier
    const payableResult = await createPayable({
      company: companyId,
      carrier: load.assignedCarrier,
      lineItems: [{
        description: `Freight: ${load.loadNumber} - ${load.commodity}`,
        quantity: 1,
        unitPrice: load.carrierCost
      }],
      currency: load.currency,
      dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000), // Net 15
      notes: `Load ${load.loadNumber}`,
      linkedLoads: [load._id],
      createdBy: userId,
      isDemoData
    }, session);
    
    // Update load status
    load.status = 'INVOICED';
    load.invoiceId = invoiceResult.invoice._id;
    load.payableId = payableResult.payable._id;
    await load.save({ session });
    
    await LoadEvent.create([{ company: companyId, load: load._id, type: 'financial', status: 'INVOICED', summary: `Invoice and payable auto-created`, occurredAt: new Date(), actor: userId, actorRole: 'system', isDemoData }], { session });
    
  } catch (error) {
    console.error('Auto financial creation failed:', error);
    await LoadEvent.create([{ company: companyId, load: load._id, type: 'exception', status: 'EXCEPTION', summary: `Auto financial creation failed: ${error.message}`, occurredAt: new Date(), actor: userId, actorRole: 'system', isDemoData }], { session });
  }
}

/**
 * Record proof of delivery
 * @param {Object} params - POD parameters
 * @returns {Promise<Object>} Updated load
 */
async function recordPOD(params) {
  return withTransaction(async (session) => {
    const { loadId, userId, signedBy, documentUri, conditionAtDelivery, notes, companyId, isDemoData = false } = params;
    
    const load = await Load.findById(loadId).session(session);
    if (!load) throw new Error('Load not found');
    
    if (!['DELIVERED', 'IN_TRANSIT'].includes(load.status)) {
      throw new Error(`Cannot record POD for load in status: ${load.status}`);
    }
    
    // Update delivery proof
    load.deliveryProof = {
      confirmedAt: new Date(),
      confirmedBy: String(userId),
      confirmedByRole: 'broker',
      signedBy,
      documentUri,
      conditionAtDelivery,
      notes
    };
    
    load.status = 'POD_RECEIVED';
    load.updatedBy = userId;
    await load.save({ session });
    
    await LoadEvent.create([{ company: companyId, load: load._id, type: 'pod', status: 'POD_RECEIVED', summary: `Proof of delivery received from ${signedBy}`, details: { signedBy, conditionAtDelivery, notes }, occurredAt: new Date(), actor: userId, actorRole: 'broker', isDemoData }], { session });
    
    await recordAuditEvent({ action: 'POD_RECEIVED', entityType: 'Load', entityId: load._id, companyId, actor: { id: userId }, summary: `POD received for load ${load.loadNumber}`, severity: 'info', metadata: { signedBy, conditionAtDelivery } }, { session });
    
    // Auto-create financials
    await autoCreateFinancials(load, userId, companyId, isDemoData, session);
    
    return load;
  });
}

/**
 * Get load profitability
 * @param {ObjectId} loadId - Load ID
 * @param {ObjectId} companyId - Company ID
 * @returns {Promise<Object>} Profitability analysis
 */
async function getLoadProfitability(loadId, companyId) {
  const load = await Load.findOne({ _id: loadId, company: companyId })
    .populate('assignedCarrier', 'legalName dotNumber')
    .populate('customer', 'name');
  
  if (!load) throw new Error('Load not found');
  
  const revenue = load.customerRate || 0;
  const carrierCost = load.carrierCost || 0;
  const accessorials = load.accessorials || 0;
  const otherCosts = (load.otherCosts || 0);
  
  const grossMargin = revenue - carrierCost - accessorials - otherCosts;
  const marginPercent = revenue > 0 ? ((grossMargin / revenue) * 100).toFixed(2) : 0;
  
  return {
    loadNumber: load.loadNumber,
    customer: load.customer?.name,
    carrier: load.assignedCarrier?.legalName,
    revenue,
    carrierCost,
    accessorials,
    otherCosts,
    grossMargin,
    marginPercent: parseFloat(marginPercent),
    status: load.status,
    isProfitable: grossMargin > 0
  };
}

/**
 * Get load timeline (all events)
 * @param {ObjectId} loadId - Load ID
 * @param {ObjectId} companyId - Company ID
 * @returns {Promise<Array>} Timeline events
 */
async function getLoadTimeline(loadId, companyId) {
  const events = await LoadEvent.find({ load: loadId, company: companyId })
    .sort({ occurredAt: 1 })
    .populate('actor', 'name email');
  
  return events.map(e => ({
    id: e._id,
    type: e.type,
    status: e.status,
    summary: e.summary,
    details: e.details,
    occurredAt: e.occurredAt,
    actor: e.actor ? { id: e.actor._id, name: e.actor.name, email: e.actor.email } : null,
    actorRole: e.actorRole
  }));
}

/**
 * Search loads with advanced filters
 * @param {Object} params - Search parameters
 * @returns {Promise<Object>} Paginated results
 */
async function searchLoads(params) {
  const { companyId, status, carrierId, customerId, dateFrom, dateTo, loadNumber, minMargin, maxMargin, page = 1, limit = 20, sort = '-createdAt' } = params;
  
  const filter = { company: companyId, isDemoData: false, ownershipResolved: true };
  if (status) filter.status = status;
  if (carrierId) filter.assignedCarrier = carrierId;
  if (customerId) filter.customer = customerId;
  if (loadNumber) filter.loadNumber = { $regex: loadNumber, $options: 'i' };
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
    if (dateTo) filter.createdAt.$lte = new Date(dateTo);
  }
  if (minMargin !== undefined || maxMargin !== undefined) {
    filter.margin = {};
    if (minMargin !== undefined) filter.margin.$gte = minMargin;
    if (maxMargin !== undefined) filter.margin.$lte = maxMargin;
  }
  
  const skip = (page - 1) * limit;
  
  const [loads, total] = await Promise.all([
    Load.find(filter)
      .populate('assignedCarrier', 'legalName dotNumber mcNumber overallStatus')
      .populate('customer', 'name')
      .sort(sort)
      .skip(skip)
      .limit(limit),
    Load.countDocuments(filter)
  ]);
  
  return {
    loads: loads.map(l => ({
      id: l._id,
      loadNumber: l.loadNumber,
      status: l.status,
      origin: l.origin,
      destination: l.destination,
      commodity: l.commodity,
      equipmentType: l.equipmentType,
      customerRate: l.customerRate,
      carrierCost: l.carrierCost,
      margin: l.margin,
      marginPercent: l.marginPercent,
      carrier: l.assignedCarrier?.legalName,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}

/**
 * Get load board (available loads for carrier matching)
 * @param {Object} params - Load board parameters
 * @returns {Promise<Array>} Available loads
 */
async function getLoadBoard(params) {
  const { companyId, equipmentType, originState, destinationState, dateFrom, dateTo } = params;
  
  const filter = { company: companyId, status: 'POSTED', isDemoData: false, ownershipResolved: true };
  if (equipmentType) filter.equipmentType = equipmentType;
  if (originState) filter['origin.state'] = originState;
  if (destinationState) filter['destination.state'] = destinationState;
  if (dateFrom || dateTo) {
    filter['origin.pickupDate'] = {};
    if (dateFrom) filter['origin.pickupDate'].$gte = new Date(dateFrom);
    if (dateTo) filter['origin.pickupDate'].$lte = new Date(dateTo);
  }
  
  return Load.find(filter)
    .populate('customer', 'name')
    .sort({ 'origin.pickupDate': 1 })
    .limit(100)
    .lean();
}

/**
 * Find eligible carriers for a load
 * @param {Object} params - Eligibility parameters
 * @returns {Promise<Array>} Eligible carriers with match reasons
 */
async function findEligibleCarriers(params) {
  const { loadId, companyId, limit = 20 } = params;
  
  const load = await Load.findById(loadId).populate('company');
  if (!load) throw new Error('Load not found');
  
  // Get all carriers for company
  const carriers = await Carrier.find({ company: companyId, isArchived: false, isDemoData: false })
    .limit(100);
  
  // Evaluate each carrier
  const { evaluateCarrierForLoad } = require('./vettingEngine');
  const results = [];
  
  for (const carrier of carriers) {
    const evaluation = evaluateCarrierForLoad(carrier, load);
    results.push({
      carrier: {
        id: carrier._id,
        legalName: carrier.legalName,
        dotNumber: carrier.dotNumber,
        mcNumber: carrier.mcNumber,
        overallStatus: carrier.overallStatus,
        equipment: carrier.equipment.filter(e => e.status === 'active').length
      },
      evaluation: {
        overallStatus: evaluation.overallStatus,
        isEligible: evaluation.isEligible,
        summary: evaluation.summary,
        passedChecks: evaluation.summary.passedChecks,
        failedChecks: evaluation.summary.failedChecks,
        reviewChecks: evaluation.summary.reviewChecks
      }
    });
  }
  
  // Sort: PASS first, then NEEDS_REVIEW, then UNKNOWN, then FAIL
  const statusOrder = { PASS: 0, NEEDS_REVIEW: 1, UNKNOWN: 2, FAIL: 3 };
  results.sort((a, b) => (statusOrder[a.evaluation.overallStatus] || 4) - (statusOrder[b.evaluation.overallStatus] || 4));
  
  return results.slice(0, limit);
}

/**
 * Cancel load
 * @param {Object} params - Cancel parameters
 * @returns {Promise<Object>} Cancelled load
 */
async function cancelLoad(params) {
  return withTransaction(async (session) => {
    const { loadId, userId, reason, companyId, isDemoData = false } = params;
    
    const load = await Load.findById(loadId).session(session);
    if (!load) throw new Error('Load not found');
    
    if (['DELIVERED', 'POD_RECEIVED', 'INVOICED', 'PAID', 'RECONCILED', 'CANCELLED'].includes(load.status)) {
      throw new Error(`Cannot cancel load in status: ${load.status}`);
    }
    
    const oldStatus = load.status;
    load.status = 'CANCELLED';
    load.cancellationReason = reason;
    load.cancelledAt = new Date();
    load.cancelledBy = userId;
    load.updatedBy = userId;
    await load.save({ session });
    
    await LoadEvent.create([{ company: companyId, load: load._id, type: 'cancelled', status: 'CANCELLED', summary: `Load cancelled: ${reason}`, occurredAt: new Date(), actor: userId, actorRole: 'broker', isDemoData }], { session });
    
    await recordAuditEvent({ action: 'LOAD_CANCELLED', entityType: 'Load', entityId: load._id, companyId, actor: { id: userId }, summary: `Load ${load.loadNumber} cancelled`, severity: 'warning', metadata: { oldStatus, reason } }, { session });
    
    // Cancel any active tenders
    const Tender = mongoose.model('Tender');
    await Tender.updateMany({ load: loadId, status: { $in: ['SENT', 'VIEWED', 'COUNTERED'] } }, { $set: { status: 'WITHDRAWN', respondedAt: new Date(), respondedBy: userId } }, { session });
    
    return load;
  });
}

module.exports = {
  createLoad,
  sendTenderToCarrier,
  updateLoadStatus,
  recordPOD,
  getLoadProfitability,
  getLoadTimeline,
  searchLoads,
  getLoadBoard,
  findEligibleCarriers,
  cancelLoad,
  autoCreateFinancials,
  LOAD_STATUSES
};
