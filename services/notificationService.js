const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const User = require('../models/User');
const Company = require('../models/Company');
const { recordAuditEvent } = require('./auditService');

class NotificationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const NOTIFICATION_READ_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer', 'platform_admin', 'platform_support']);
const NOTIFICATION_WRITE_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'platform_admin']);

function assertCompany(req, { allowDemo = false } = {}) {
  const explicitDemo = req.headers && req.headers['x-demo-mode'] === 'true';
  const queryDemo = req.query && req.query.demo === 'true';
  if (req.isDemoMode || explicitDemo || queryDemo) {
    if (!allowDemo || explicitDemo || queryDemo) {
      throw new NotificationError(403, 'DEMO_NOT_ALLOWED', 'This operation is not available in demo mode.');
    }
    return;
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new NotificationError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertRole(req, allowed, action) {
  if (req.isDemoMode) return;
  const role = req.membership && req.membership.role;
  if (!role || !allowed.has(role)) {
    throw new NotificationError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action}.`);
  }
}

function oid(id, label) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ''))) throw new NotificationError(400, 'INVALID_ID', `${label} must be a valid ObjectId`);
}

function ensureBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new NotificationError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  for (const f of ['company', 'isDemoData', 'createdBy', 'updatedBy', '_id', 'createdAt', 'updatedAt', '__v']) {
    if (Object.prototype.hasOwnProperty.call(body, f)) throw new NotificationError(400, 'INVALID_FIELDS', `Protected field cannot be set: ${f}`);
  }
}

function tenantFilter(req) {
  return req.isDemoMode ? { isDemoData: true } : { company: req.companyId, isDemoData: false };
}

async function findTenantDoc(Model, req, id, label, { populate = null } = {}) {
  oid(id, label);
  let q = Model.findOne({ _id: id, ...tenantFilter(req) });
  if (populate) q = q.populate(populate);
  const doc = await q;
  if (doc) return doc;
  const exists = await Model.findById(id).select('company isDemoData');
  if (!exists) throw new NotificationError(404, 'NOT_FOUND', `${label} not found.`);
  if (req.isDemoMode) throw new NotificationError(403, 'FORBIDDEN_TENANT_ACCESS', `${label} is not accessible in demo mode.`);
  if (exists.isDemoData) throw new NotificationError(403, 'FORBIDDEN_TENANT_ACCESS', `Demo ${label.toLowerCase()} cannot be accessed in company context.`);
  if (String(exists.company) !== String(req.companyId)) throw new NotificationError(403, 'FORBIDDEN_TENANT_ACCESS', `${label} does not belong to the active company.`);
  throw new NotificationError(404, 'NOT_FOUND', `${label} not found.`);
}

async function listNotifications(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, NOTIFICATION_READ_ROLES, 'read notifications');
  const filter = tenantFilter(req);
  filter.user = req.user && req.user.id;
  if (query.isRead !== undefined) filter.isRead = query.isRead === 'true';
  if (query.type) filter.type = String(query.type);
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(String(query.limit || '50'), 10) || 50), 200);
  const skip = (page - 1) * limit;
  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ ...filter, isRead: false })
  ]);
  return {
    success: true,
    count: items.length,
    total,
    page,
    limit,
    unreadCount,
    notifications: items.map((n) => n.toObject())
  };
}

async function createNotification(req, body) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, NOTIFICATION_WRITE_ROLES, 'create notifications');
  ensureBody(body);
  if (!body.user || !mongoose.Types.ObjectId.isValid(String(body.user))) throw new NotificationError(400, 'REQUIRED_FIELD', 'A valid user is required.');
  if (!body.title || !String(body.title).trim()) throw new NotificationError(400, 'REQUIRED_FIELD', 'Notification title is required.');
  if (!body.message || !String(body.message).trim()) throw new NotificationError(400, 'REQUIRED_FIELD', 'Notification message is required.');
  // Validate the target user exists (users belong to companies via Membership, not a direct company field)
  const targetUser = await User.findById(body.user).select('_id email role isDemoData');
  if (!targetUser) throw new NotificationError(404, 'NOT_FOUND', 'Target user not found.');
  const doc = await Notification.create({
    ...body,
    user: body.user,
    title: String(body.title).trim(),
    message: String(body.message).trim(),
    company: req.isDemoMode ? undefined : req.companyId,
    isDemoData: Boolean(req.isDemoMode),
    createdBy: req.user && req.user.id,
    updatedBy: req.user && req.user.id
  });
  await recordAuditEvent({
    companyId: req.companyId || null,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'NOTIFICATION_CREATED',
    entityType: 'Notification',
    entityId: doc._id,
    summary: `Notification created: ${doc.title}`,
    metadata: { notificationType: doc.type, user: doc.user, company: doc.company },
    isDemoData: Boolean(req.isDemoMode)
  });
  return { success: true, notification: doc.toObject() };
}

async function getNotification(req, id) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, NOTIFICATION_READ_ROLES, 'read notifications');
  const doc = await findTenantDoc(Notification, req, id, 'Notification');
  return { success: true, notification: doc.toObject() };
}

async function markNotificationRead(req, id) {
  assertCompany(req, { allowDemo: false }); assertRole(req, NOTIFICATION_WRITE_ROLES, 'mark notification read');
  const doc = await findTenantDoc(Notification, req, id, 'Notification');
  if (doc.isRead) throw new NotificationError(409, 'NOTIFICATION_READ', 'Notification is already marked as read.');
  doc.isRead = true;
  doc.readAt = new Date();
  doc.updatedBy = req.user && req.user.id;
  await doc.save();
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'NOTIFICATION_READ',
    entityType: 'Notification',
    entityId: doc._id,
    summary: 'Notification marked as read',
    metadata: { notificationType: doc.type },
    isDemoData: false
  });
  return { success: true, notification: doc.toObject() };
}

async function markAllNotificationsRead(req) {
  assertCompany(req, { allowDemo: false }); assertRole(req, NOTIFICATION_WRITE_ROLES, 'mark all notifications read');
  const filter = { ...tenantFilter(req), user: req.user && req.user.id, isRead: false };
  const result = await Notification.updateMany(filter, {
    isRead: true,
    readAt: new Date(),
    updatedBy: req.user && req.user.id
  });
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'NOTIFICATIONS_ALL_READ',
    entityType: 'Notification',
    entityId: null,
    summary: `Marked ${result.modifiedCount} notifications as read`,
    metadata: { modifiedCount: result.modifiedCount },
    isDemoData: false
  });
  return { success: true, modifiedCount: result.modifiedCount };
}

async function deleteNotification(req, id) {
  assertCompany(req, { allowDemo: false }); assertRole(req, NOTIFICATION_WRITE_ROLES, 'delete notifications');
  const doc = await findTenantDoc(Notification, req, id, 'Notification');
  await doc.deleteOne();
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'NOTIFICATION_DELETED',
    entityType: 'Notification',
    entityId: id,
    summary: 'Notification deleted',
    metadata: { notificationType: doc.type },
    isDemoData: false
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

async function getPreferences(req) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, NOTIFICATION_READ_ROLES, 'read notification preferences');
  const filter = tenantFilter(req);
  filter.user = req.user && req.user.id;
  let prefs = await NotificationPreference.findOne(filter);
  if (!prefs) {
    // Create default preferences
    prefs = await NotificationPreference.create({
      user: req.user && req.user.id,
      company: req.isDemoMode ? undefined : req.companyId,
      email: true,
      sms: false,
      push: true,
      types: {
        assignment: true, tender: true, exception: true, payment: true,
        compliance: true, system: true, info: true, warning: true, error: true, success: true
      },
      quietHours: { enabled: false, start: '22:00', end: '08:00', timezone: 'UTC' },
      isDemoData: Boolean(req.isDemoMode),
      createdBy: req.user && req.user.id,
      updatedBy: req.user && req.user.id
    });
  }
  return { success: true, preferences: prefs.toObject() };
}

async function updatePreferences(req, body) {
  assertCompany(req, { allowDemo: false }); assertRole(req, NOTIFICATION_WRITE_ROLES, 'update notification preferences');
  ensureBody(body);
  const filter = { user: req.user && req.user.id, ...tenantFilter(req) };
  const allowedFields = ['email', 'sms', 'push', 'types', 'quietHours'];
  const update = {};
  for (const k of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(body, k)) update[k] = body[k];
  }
  update.updatedBy = req.user && req.user.id;
  const doc = await NotificationPreference.findOneAndUpdate(filter, update, { new: true, upsert: true });
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'NOTIFICATION_PREFERENCES_UPDATED',
    entityType: 'NotificationPreference',
    entityId: doc._id,
    summary: 'Notification preferences updated',
    metadata: { channels: Object.keys(update).filter(k => k !== 'updatedBy') },
    isDemoData: false
  });
  return { success: true, preferences: doc.toObject() };
}

// ---------------------------------------------------------------------------
// Cleanup / retention
// ---------------------------------------------------------------------------

async function cleanupOldNotifications(req, body = {}) {
  assertCompany(req, { allowDemo: false }); assertRole(req, NOTIFICATION_WRITE_ROLES, 'cleanup notifications');
  const filter = { ...tenantFilter(req), user: req.user && req.user.id };
  const olderThanDays = body.olderThanDays !== undefined ? Number(body.olderThanDays) : 90;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) throw new NotificationError(400, 'INVALID_FIELD', 'olderThanDays must be a positive number.');
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await Notification.deleteMany({ ...filter, updatedAt: { $lt: cutoff } });
  await recordAuditEvent({
    companyId: req.companyId,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'NOTIFICATIONS_CLEANED',
    entityType: 'Notification',
    entityId: null,
    summary: `Deleted ${result.deletedCount} old notifications (older than ${olderThanDays} days)`,
    metadata: { olderThanDays, deletedCount: result.deletedCount },
    isDemoData: false
  });
  return { success: true, deletedCount: result.deletedCount, olderThanDays };
}

module.exports = {
  NotificationError,
  listNotifications, createNotification, getNotification, markNotificationRead, markAllNotificationsRead, deleteNotification,
  getPreferences, updatePreferences, cleanupOldNotifications,
  NOTIFICATION_READ_ROLES, NOTIFICATION_WRITE_ROLES
};
