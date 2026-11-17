const AuditEvent = require('../models/AuditEvent');

const safeString = (v) => (v === undefined || v === null) ? undefined : String(v);

async function recordAuditEvent({
  companyId = null,
  actorId = null,
  actorRole = null,
  action,
  entityType,
  entityId = null,
  summary = null,
  changes = null,
  metadata = null,
  severity = 'info',
  isDemoData = false,
  occurredAt = new Date()
} = {}) {
  try {
    if (!action || !entityType) return null;
    const doc = await AuditEvent.create({
      company: companyId || undefined,
      actor: actorId || undefined,
      actorRole: actorRole || undefined,
      action: String(action),
      entityType: String(entityType),
      entityId: safeString(entityId),
      summary: summary ? String(summary) : undefined,
      changes: changes || undefined,
      metadata: metadata || undefined,
      severity: ['info', 'warning', 'critical'].includes(severity) ? severity : 'info',
      isDemoData: Boolean(isDemoData),
      occurredAt
    });
    return doc;
  } catch (error) {
    // Audit logging must never break primary workflows.
    return null;
  }
}

async function listAuditEvents({ companyId, entityType, entityId, limit = 50 } = {}) {
  const filter = {};
  if (companyId) filter.company = companyId;
  if (entityType) filter.entityType = String(entityType);
  if (entityId) filter.entityId = String(entityId);
  const capped = Math.max(1, Math.min(200, Number(limit) || 50));
  return AuditEvent.find(filter)
    .sort({ occurredAt: -1, createdAt: -1 })
    .limit(capped)
    .populate('actor', 'name email')
    .lean();
}

module.exports = { recordAuditEvent, listAuditEvents };
