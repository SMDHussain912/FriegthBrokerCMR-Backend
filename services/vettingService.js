const mongoose = require('mongoose');
const Carrier = require('../models/Carrier');
const VettingConfiguration = require('../models/VettingConfiguration');
const { evaluateCarrierForLoad, RULE_VERSION } = require('./vettingEngine');
const { findCarrierForTenant, toPublicCarrier } = require('./carrierService');

const MAX_AUDIT_ENTRIES = 100;
const CONFIG_READ_ROLES = new Set([
  'broker_owner', 'broker_admin', 'broker', 'operations_manager',
  'compliance_officer', 'finance', 'viewer', 'platform_admin', 'platform_support'
]);
const CONFIG_WRITE_ROLES = new Set(['broker_owner', 'broker_admin', 'compliance_officer', 'platform_admin']);
const EVALUATION_ROLES = new Set([
  'broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'platform_admin'
]);

class VettingApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const assertTenantContext = (req) => {
  if (req.isDemoMode) {
    throw new VettingApiError(403, 'DEMO_READ_ONLY', 'Demo context does not allow company vetting configuration changes.');
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new VettingApiError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
};

const assertRole = (req, allowedRoles, action) => {
  const role = req.membership && req.membership.role;
  if (!role || !allowedRoles.has(role)) {
    throw new VettingApiError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action} vetting data.`);
  }
};

const toPublicConfig = (config) => {
  if (!config) return null;
  const obj = config.toObject ? config.toObject() : { ...config };
  delete obj.auditLog;
  return obj;
};

const buildBaselineLoad = (config) => ({
  loadNumber: 'BASELINE-EVALUATION',
  commodity: 'General Freight',
  equipmentType: 'DRY_VAN',
  declaredCargoValue: Number(config?.minimumCargoLimit || 100000),
  loadRequirements: {
    minAuthorityAgeDays: Number(config?.minimumAuthorityDays || 90),
    minAutoLiability: Number(config?.minimumLiabilityLimit || 1000000),
    requireReeferEndorsement: false,
    disallowConditionalSafety: true
  }
});

const appendAudit = (config, action, actorId, payload = {}) => {
  const log = config.auditLog || [];
  config.auditLog = [...log, {
    action,
    actor: actorId,
    changedFields: payload.changedFields || [],
    reason: payload.reason,
    metadata: payload.metadata,
    occurredAt: new Date()
  }].slice(-MAX_AUDIT_ENTRIES);
};

async function getOrCreateCompanyConfig(req, { createIfMissing = false } = {}) {
  assertTenantContext(req);
  assertRole(req, CONFIG_READ_ROLES, 'read');
  let config = await VettingConfiguration.findOne({ company: req.companyId });
  if (!config && createIfMissing) {
    config = new VettingConfiguration({
      company: req.companyId,
      createdBy: req.user.id,
      updatedBy: req.user.id,
      lastModifiedBy: req.user.id,
      auditLog: [{ action: 'CREATED', actor: req.user.id, changedFields: ['company'], occurredAt: new Date() }]
    });
    await config.save();
  }
  return config;
}

async function updateCompanyConfig(req, body) {
  assertTenantContext(req);
  assertRole(req, CONFIG_WRITE_ROLES, 'update');
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new VettingApiError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  }
  const allowed = new Set([
    'minimumAuthorityDays',
    'maximumOutOfServicePercentiles',
    'minimumLiabilityLimit',
    'requiredInsuranceDocuments',
    'minimumCargoLimit',
    'isActive',
    'reason'
  ]);
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new VettingApiError(400, 'INVALID_FIELDS', `Unsupported fields: ${unknown.join(', ')}`);
  }
  const config = await VettingConfiguration.findOne({ company: req.companyId }).select('+auditLog') || new VettingConfiguration({
    company: req.companyId,
    createdBy: req.user.id,
    auditLog: []
  });

  const changedFields = [];
  const setIfChanged = (field, value) => {
    if (value === undefined) return;
    const before = config[field];
    config[field] = value;
    const after = config[field];
    if (JSON.stringify(before) !== JSON.stringify(after)) changedFields.push(field);
  };

  if (body.minimumAuthorityDays !== undefined) {
    if (!Number.isInteger(body.minimumAuthorityDays) || body.minimumAuthorityDays < 1) {
      throw new VettingApiError(400, 'INVALID_FIELD', 'minimumAuthorityDays must be a positive integer.');
    }
    setIfChanged('minimumAuthorityDays', body.minimumAuthorityDays);
  }
  if (body.maximumOutOfServicePercentiles !== undefined) {
    if (typeof body.maximumOutOfServicePercentiles !== 'number' || body.maximumOutOfServicePercentiles < 0 || body.maximumOutOfServicePercentiles > 100) {
      throw new VettingApiError(400, 'INVALID_FIELD', 'maximumOutOfServicePercentiles must be between 0 and 100.');
    }
    setIfChanged('maximumOutOfServicePercentiles', body.maximumOutOfServicePercentiles);
  }
  if (body.minimumLiabilityLimit !== undefined) {
    if (typeof body.minimumLiabilityLimit !== 'number' || body.minimumLiabilityLimit < 0) {
      throw new VettingApiError(400, 'INVALID_FIELD', 'minimumLiabilityLimit must be a non-negative number.');
    }
    setIfChanged('minimumLiabilityLimit', body.minimumLiabilityLimit);
  }
  if (body.minimumCargoLimit !== undefined) {
    if (typeof body.minimumCargoLimit !== 'number' || body.minimumCargoLimit < 0) {
      throw new VettingApiError(400, 'INVALID_FIELD', 'minimumCargoLimit must be a non-negative number.');
    }
    setIfChanged('minimumCargoLimit', body.minimumCargoLimit);
  }
  if (body.requiredInsuranceDocuments !== undefined) {
    if (!Array.isArray(body.requiredInsuranceDocuments) || body.requiredInsuranceDocuments.some((v) => typeof v !== 'string' || !v.trim())) {
      throw new VettingApiError(400, 'INVALID_FIELD', 'requiredInsuranceDocuments must be an array of strings.');
    }
    setIfChanged('requiredInsuranceDocuments', body.requiredInsuranceDocuments.map((v) => v.trim()));
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') {
      throw new VettingApiError(400, 'INVALID_FIELD', 'isActive must be a boolean.');
    }
    setIfChanged('isActive', body.isActive);
  }

  if (changedFields.length === 0 && config.isNew) {
    // allow initial creation with defaults only when explicit save desired? no-op for existing handled below
  }
  if (!config.isNew && changedFields.length === 0) {
    return config;
  }

  config.updatedBy = req.user.id;
  config.lastModifiedBy = req.user.id;
  appendAudit(config, config.isNew ? 'CREATED' : 'UPDATED', req.user.id, {
    changedFields: config.isNew ? ['company', ...changedFields] : changedFields,
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined
  });
  await config.save();
  return config;
}

async function evaluateCarrier(req, carrierId) {
  assertTenantContext(req);
  assertRole(req, EVALUATION_ROLES, 'evaluate');
  if (!mongoose.Types.ObjectId.isValid(String(carrierId))) {
    throw new VettingApiError(400, 'INVALID_ID', 'Carrier ID must be a valid ObjectId.');
  }
  const carrier = await findCarrierForTenant(req, carrierId);
  const config = await VettingConfiguration.findOne({ company: req.companyId }).select('+auditLog');
  const evaluation = evaluateCarrierForLoad(carrier, buildBaselineLoad(config));

  // Audit evaluation on company-scoped config history (if config exists, else create record for traceability)
  let auditConfig = config;
  if (!auditConfig) {
    auditConfig = new VettingConfiguration({
      company: req.companyId,
      createdBy: req.user.id,
      auditLog: []
    });
  } else if (!auditConfig.auditLog) {
    auditConfig = await VettingConfiguration.findOne({ company: req.companyId }).select('+auditLog');
  }
  auditConfig.updatedBy = req.user.id;
  auditConfig.lastModifiedBy = req.user.id;
  appendAudit(auditConfig, 'EVALUATED', req.user.id, {
    changedFields: ['evaluation'],
    metadata: {
      carrierId: String(carrier._id),
      overallStatus: evaluation.overallStatus,
      isEligible: evaluation.isEligible,
      ruleVersion: evaluation.ruleVersion || RULE_VERSION,
      evaluatedAt: evaluation.evaluatedAt
    }
  });
  await auditConfig.save();

  return {
    evaluation,
    carrier: toPublicCarrier(carrier),
    configuration: toPublicConfig(auditConfig)
  };
}

async function getConfigAudit(req) {
  assertTenantContext(req);
  assertRole(req, CONFIG_READ_ROLES, 'read');
  const config = await VettingConfiguration.findOne({ company: req.companyId }).select('+auditLog').populate('auditLog.actor', 'name email');
  if (!config) {
    return [];
  }
  return (config.auditLog || []).map((entry) => ({
    action: entry.action,
    actor: entry.actor && typeof entry.actor === 'object' ? {
      id: String(entry.actor._id),
      name: entry.actor.name,
      email: entry.actor.email
    } : (entry.actor ? String(entry.actor) : null),
    changedFields: entry.changedFields || [],
    reason: entry.reason || null,
    metadata: entry.metadata || null,
    occurredAt: entry.occurredAt
  }));
}

module.exports = {
  VettingApiError,
  toPublicConfig,
  getOrCreateCompanyConfig,
  updateCompanyConfig,
  evaluateCarrier,
  getConfigAudit,
  CONFIG_READ_ROLES,
  CONFIG_WRITE_ROLES,
  EVALUATION_ROLES
};
