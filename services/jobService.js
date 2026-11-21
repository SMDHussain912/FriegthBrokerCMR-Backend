const mongoose = require('mongoose');
const Job = require('../models/Job');
const { recordAuditEvent } = require('./auditService');

class JobError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const JOB_WRITE_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'platform_admin']);
const JOB_READ_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer', 'platform_admin', 'platform_support']);

const JOB_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);

function assertCompany(req, { allowDemo = false } = {}) {
  const explicitDemo = req.headers && req.headers['x-demo-mode'] === 'true';
  const queryDemo = req.query && req.query.demo === 'true';
  if (req.isDemoMode || explicitDemo || queryDemo) {
    if (!allowDemo || explicitDemo || queryDemo) {
      throw new JobError(403, 'DEMO_NOT_ALLOWED', 'This operation is not available in demo mode.');
    }
    return;
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new JobError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertRole(req, allowed, action) {
  if (req.isDemoMode) return;
  const role = req.membership && req.membership.role;
  if (!role || !allowed.has(role)) {
    throw new JobError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action}.`);
  }
}

function oid(id, label) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ''))) throw new JobError(400, 'INVALID_ID', `${label} must be a valid ObjectId`);
}

function ensureBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new JobError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  for (const f of ['company', 'isDemoData', 'createdBy', 'updatedBy', '_id', 'createdAt', 'updatedAt', '__v']) {
    if (Object.prototype.hasOwnProperty.call(body, f)) throw new JobError(400, 'INVALID_FIELDS', `Protected field cannot be set: ${f}`);
  }
}

function tenantFilter(req) {
  return req.isDemoMode ? { isDemoData: true } : { company: req.companyId, isDemoData: false };
}

async function findTenantJob(req, id, { populate = null } = {}) {
  oid(id, 'job');
  let q = Job.findOne({ _id: id, ...tenantFilter(req) });
  if (populate) q = q.populate(populate);
  const doc = await q;
  if (doc) return doc;
  const exists = await Job.findById(id).select('company isDemoData');
  if (!exists) throw new JobError(404, 'NOT_FOUND', 'Job not found.');
  if (req.isDemoMode) throw new JobError(403, 'FORBIDDEN_TENANT_ACCESS', 'Job is not accessible in demo mode.');
  if (exists.isDemoData) throw new JobError(403, 'FORBIDDEN_TENANT_ACCESS', 'Demo job cannot be accessed in company context.');
  if (String(exists.company) !== String(req.companyId)) throw new JobError(403, 'FORBIDDEN_TENANT_ACCESS', 'Job does not belong to the active company.');
  throw new JobError(404, 'NOT_FOUND', 'Job not found.');
}

async function enqueueJob(req, body) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, JOB_WRITE_ROLES, 'create jobs');
  ensureBody(body);
  if (!body.type || !String(body.type).trim()) throw new JobError(400, 'REQUIRED_FIELD', 'Job type is required.');
  const type = String(body.type).trim();
  const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {};
  const maxRetries = body.maxRetries !== undefined ? Number(body.maxRetries) : 3;
  if (!Number.isFinite(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new JobError(400, 'INVALID_FIELD', 'maxRetries must be between 0 and 10.');
  const retryDelayMs = body.retryDelayMs !== undefined ? Number(body.retryDelayMs) : 1000;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new JobError(400, 'INVALID_FIELD', 'retryDelayMs must be a non-negative number.');
  const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : new Date();
  const idempotencyKey = body.idempotencyKey ? String(body.idempotencyKey).trim() : undefined;

  // Idempotency: if a pending/running job with the same key exists, return it
  if (idempotencyKey) {
    const existing = await Job.findOne({ company: req.companyId, idempotencyKey, isDemoData: req.isDemoData, status: { $in: ['pending', 'running'] } });
    if (existing) return { success: true, job: existing.toObject(), fromCache: true };
  }

  const doc = await Job.create({
    type,
    payload,
    status: 'pending',
    maxRetries,
    retryCount: 0,
    retryDelayMs,
    scheduledAt,
    idempotencyKey,
    company: req.isDemoMode ? undefined : req.companyId,
    isDemoData: Boolean(req.isDemoMode),
    createdBy: req.user && req.user.id,
    updatedBy: req.user && req.user.id
  });
  await recordAuditEvent({
    companyId: req.companyId || null,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'JOB_ENQUEUED',
    entityType: 'Job',
    entityId: doc._id,
    summary: `Job enqueued: ${doc.type}`,
    metadata: { jobType: doc.type, idempotencyKey },
    isDemoData: Boolean(req.isDemoMode)
  });
  return { success: true, job: doc.toObject(), fromCache: false };
}

async function listJobs(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, JOB_READ_ROLES, 'read jobs');
  const filter = tenantFilter(req);
  if (query.type) filter.type = String(query.type);
  if (query.status) filter.status = String(query.status);
  if (query.idempotencyKey) filter.idempotencyKey = String(query.idempotencyKey);
  if (query.q) {
    filter.$or = [
      { type: { $regex: String(query.q).slice(0, 100), $options: 'i' } },
      { error: { $regex: String(query.q).slice(0, 100), $options: 'i' } }
    ];
  }
  if (query.scheduledFrom || query.scheduledTo) {
    filter.scheduledAt = {};
    if (query.scheduledFrom) filter.scheduledAt.$gte = new Date(query.scheduledFrom);
    if (query.scheduledTo) filter.scheduledAt.$lte = new Date(query.scheduledTo);
  }
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(String(query.limit || '50'), 10) || 50), 200);
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Job.find(filter).sort({ scheduledAt: 1, createdAt: -1 }).skip(skip).limit(limit),
    Job.countDocuments(filter)
  ]);
  return {
    success: true,
    count: items.length,
    total,
    page,
    limit,
    jobs: items.map((j) => j.toObject())
  };
}

async function getJob(req, id) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, JOB_READ_ROLES, 'read jobs');
  const doc = await findTenantJob(req, id);
  return { success: true, job: doc.toObject() };
}

async function retryJob(req, id) {
  assertCompany(req, { allowDemo: false }); assertRole(req, JOB_WRITE_ROLES, 'retry jobs');
  const doc = await findTenantJob(req, id);
  if (!doc.isRetryable()) throw new JobError(400, 'NOT_RETRYABLE', 'Job is not retryable.');
  doc.status = 'pending';
  doc.retryCount += 1;
  doc.error = undefined;
  doc.errorDetails = undefined;
  doc.scheduledAt = new Date(Date.now() + doc.nextRetryDelay());
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'JOB_RETRIED',
    entityType: 'Job',
    entityId: doc._id,
    summary: `Job retried: ${doc.type} (attempt ${doc.retryCount})`,
    metadata: { jobType: doc.type, retryCount: doc.retryCount, nextRetryAt: doc.scheduledAt },
    isDemoData: false
  });
  return { success: true, job: doc.toObject() };
}

async function cancelJob(req, id) {
  assertCompany(req, { allowDemo: false }); assertRole(req, JOB_WRITE_ROLES, 'cancel jobs');
  const doc = await findTenantJob(req, id);
  if (doc.status === 'completed' || doc.status === 'cancelled') throw new JobError(409, 'NOT_CANCELABLE', `Cannot cancel a ${doc.status} job.`);
  doc.status = 'cancelled';
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'JOB_CANCELLED',
    entityType: 'Job',
    entityId: doc._id,
    summary: `Job cancelled: ${doc.type}`,
    metadata: { jobType: doc.type, previousStatus: doc.status },
    isDemoData: false
  });
  return { success: true, job: doc.toObject() };
}

async function processDueJobs(req) {
  assertCompany(req, { allowDemo: false }); assertRole(req, JOB_WRITE_ROLES, 'process jobs');
  const now = new Date();
  const jobs = await Job.find({
    ...tenantFilter(req),
    status: 'pending',
    scheduledAt: { $lte: now }
  }).sort({ scheduledAt: 1 }).limit(50);

  const processed = [];
  for (const job of jobs) {
    job.status = 'running';
    job.startedAt = now;
    job.updatedBy = req.user && req.user.id;
    await job.save();
    processed.push({ jobId: job._id, type: job.type, status: 'running' });
  }
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'JOBS_PROCESSED',
    entityType: 'Job',
    entityId: null,
    summary: `Processed ${processed.length} jobs`,
    metadata: { count: processed.length, jobTypes: processed.map((p) => p.type) },
    isDemoData: false
  });
  return { success: true, processed: processed.map((p) => ({ jobId: p.jobId, type: p.type, status: p.status })) };
}

module.exports = {
  JobError,
  enqueueJob, listJobs, getJob, retryJob, cancelJob, processDueJobs,
  JOB_STATUSES
};
