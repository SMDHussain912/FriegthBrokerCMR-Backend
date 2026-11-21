const mongoose = require('mongoose');
const Carrier = require('../models/Carrier');
const LoadEvent = require('../models/LoadEvent');
const { recordAuditEvent } = require('./auditService');

class DocumentExpiryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const EXPIRY_READ_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer', 'platform_admin', 'platform_support']);
const EXPIRY_WRITE_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'platform_admin']);

function assertCompany(req, { allowDemo = false } = {}) {
  const explicitDemo = req.headers && req.headers['x-demo-mode'] === 'true';
  const queryDemo = req.query && req.query.demo === 'true';
  if (req.isDemoMode || explicitDemo || queryDemo) {
    if (!allowDemo || explicitDemo || queryDemo) {
      throw new DocumentExpiryError(403, 'DEMO_NOT_ALLOWED', 'This operation is not available in demo mode.');
    }
    return;
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new DocumentExpiryError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertRole(req, allowed, action) {
  if (req.isDemoMode) return;
  const role = req.membership && req.membership.role;
  if (!role || !allowed.has(role)) {
    throw new DocumentExpiryError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action}.`);
  }
}

function oid(id, label) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ''))) throw new DocumentExpiryError(400, 'INVALID_ID', `${label} must be a valid ObjectId`);
}

function ensureBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DocumentExpiryError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  for (const f of ['company', 'isDemoData', 'createdBy', 'updatedBy', '_id', 'createdAt', 'updatedAt', '__v']) {
    if (Object.prototype.hasOwnProperty.call(body, f)) throw new DocumentExpiryError(400, 'INVALID_FIELDS', `Protected field cannot be set: ${f}`);
  }
}

function tenantFilter(req) {
  return req.isDemoMode ? { isDemoData: true } : { company: req.companyId, isDemoData: false };
}

function daysUntil(date) {
  if (!date) return null;
  return Math.ceil((new Date(date).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
}

async function scanExpiringDocuments(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, EXPIRY_READ_ROLES, 'read expiring documents');
  const warningDays = parseInt(query.warningDays || '30', 10);
  if (!Number.isFinite(warningDays) || warningDays < 0) throw new DocumentExpiryError(400, 'INVALID_WARNING_DAYS', 'warningDays must be a non-negative number');

  const carriers = await Carrier.find(tenantFilter(req)).select('company dotNumber mcNumber legalName authorityStatus authorityGrantDate insurancePolicies isDemoData').lean();

  const expiring = [];
  const expired = [];

  for (const carrier of carriers) {
    const carrierName = carrier.legalName || carrier.dotNumber;

    // Check insurance policies
    for (const policy of carrier.insurancePolicies || []) {
      const days = daysUntil(policy.expirationDate);
      if (days === null) continue;
      if (days < 0) {
        expired.push({
          carrierId: carrier._id,
          carrierName,
          dotNumber: carrier.dotNumber,
          type: 'insurance',
          item: policy.policyType,
          provider: policy.insuranceProvider,
          expiredDays: Math.abs(days),
          status: policy.verificationStatus || 'UNKNOWN'
        });
      } else if (days <= warningDays) {
        expiring.push({
          carrierId: carrier._id,
          carrierName,
          dotNumber: carrier.dotNumber,
          type: 'insurance',
          item: policy.policyType,
          provider: policy.insuranceProvider,
          daysUntil: days,
          status: policy.verificationStatus || 'UNKNOWN'
        });
      }
    }

    // Check authority status
    if (carrier.authorityStatus !== 'ACTIVE') {
      const days = daysUntil(carrier.authorityGrantDate);
      expired.push({
        carrierId: carrier._id,
        carrierName,
        dotNumber: carrier.dotNumber,
        type: 'authority',
        item: carrier.authorityStatus,
        provider: 'FMCSA',
        expiredDays: null,
        status: carrier.authorityStatus
      });
    }
  }

  return {
    success: true,
    companyId: req.companyId,
    warningDays,
    expired: expired.length,
    expiring: expiring.length,
    expiredDocuments: expired,
    expiringDocuments: expiring
  };
}

async function recordExpiryAudit(req, query = {}) {
  assertCompany(req, { allowDemo: false }); assertRole(req, EXPIRY_WRITE_ROLES, 'record expiry audit');
  const result = await scanExpiringDocuments(req, query);

  const events = [];
  for (const item of result.expiredDocuments) {
    await recordAuditEvent({
      companyId: req.companyId,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'DOCUMENT_EXPIRED',
      entityType: 'Carrier',
      entityId: item.carrierId,
      summary: `Document expired: ${item.item} (${item.provider}) for carrier ${item.carrierName}`,
      metadata: {
        carrierId: item.carrierId,
        carrierName: item.carrierName,
        dotNumber: item.dotNumber,
        docType: item.type,
        document: item.item,
        provider: item.provider,
        expiredDays: item.expiredDays,
        status: item.status
      },
      isDemoData: false
    });
    events.push(item);
  }

  for (const item of result.expiringDocuments) {
    await recordAuditEvent({
      companyId: req.companyId,
      actorId: req.user && req.user.id,
      actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
      action: 'DOCUMENT_EXPIRING',
      entityType: 'Carrier',
      entityId: item.carrierId,
      summary: `Document expiring in ${item.daysUntil} days: ${item.item} (${item.provider}) for carrier ${item.carrierName}`,
      metadata: {
        carrierId: item.carrierId,
        carrierName: item.carrierName,
        dotNumber: item.dotNumber,
        docType: item.type,
        document: item.item,
        provider: item.provider,
        daysUntil: item.daysUntil,
        status: item.status
      },
      isDemoData: false
    });
    events.push(item);
  }

  return {
    success: true,
    expired: result.expired,
    expiring: result.expiring,
    recordedEvents: events.length,
    expiredDocuments: result.expiredDocuments,
    expiringDocuments: result.expiringDocuments
  };
}

module.exports = {
  DocumentExpiryError,
  scanExpiringDocuments,
  recordExpiryAudit,
  EXPIRY_READ_ROLES,
  EXPIRY_WRITE_ROLES
};
