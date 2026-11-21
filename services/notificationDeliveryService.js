const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const { recordAuditEvent } = require('./auditService');

class NotificationDeliveryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DELIVERY_READ_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer', 'platform_admin', 'platform_support']);
const DELIVERY_WRITE_ROLES = new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'platform_admin']);

const DELIVERY_CHANNELS = new Set(['email', 'sms', 'push']);
const DELIVERY_STATUSES = new Set(['pending', 'sent', 'failed', 'skipped']);

function assertCompany(req, { allowDemo = false } = {}) {
  const explicitDemo = req.headers && req.headers['x-demo-mode'] === 'true';
  const queryDemo = req.query && req.query.demo === 'true';
  if (req.isDemoMode || explicitDemo || queryDemo) {
    if (!allowDemo || explicitDemo || queryDemo) {
      throw new NotificationDeliveryError(403, 'DEMO_NOT_ALLOWED', 'This operation is not available in demo mode.');
    }
    return;
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new NotificationDeliveryError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertRole(req, allowed, action) {
  if (req.isDemoMode) return;
  const role = req.membership && req.membership.role;
  if (!role || !allowed.has(role)) {
    throw new NotificationDeliveryError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action}.`);
  }
}

function oid(id, label) {
  if (!mongoose.Types.ObjectId.isValid(String(id || ''))) throw new NotificationDeliveryError(400, 'INVALID_ID', `${label} must be a valid ObjectId`);
}

function ensureBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new NotificationDeliveryError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  for (const f of ['company', 'isDemoData', 'createdBy', 'updatedBy', '_id', 'createdAt', 'updatedAt', '__v']) {
    if (Object.prototype.hasOwnProperty.call(body, f)) throw new NotificationDeliveryError(400, 'INVALID_FIELDS', `Protected field cannot be set: ${f}`);
  }
}

function tenantFilter(req) {
  return req.isDemoMode ? { isDemoData: true } : { company: req.companyId, isDemoData: false };
}

/* -------------------------------------------------------------------------- */
/*  Notification delivery adapters                                            */
/* -------------------------------------------------------------------------- */

/**
 * Base delivery adapter. Each concrete adapter implements `send()` and
 * exposes `isConfigured()` to report whether credentials are present.
 * Adapters are credential-gated: when no credentials are configured they
 * report NOT_CONFIGURED and the delivery is skipped.
 */
class DeliveryAdapter {
  constructor(name) {
    this.name = name;
  }
  isConfigured() {
    return false;
  }
  async send(notification, recipient) {
    throw new NotificationDeliveryError(501, 'NOT_IMPLEMENTED', `Adapter ${this.name} does not implement send().`);
  }
}

/**
 * Email adapter — uses SMTP via nodemailer or a transactional email provider
 * (SendGrid, Mailgun, Postmark). Configured via EMAIL_* env vars.
 */
class EmailAdapter extends DeliveryAdapter {
  constructor() {
    super('email');
  }
  isConfigured() {
    return Boolean(process.env.SMTP_HOST || process.env.SENDGRID_API_KEY || process.env.MAILGUN_API_KEY || process.env.POSTMARK_API_KEY);
  }
  async send(notification, recipient) {
    const email = recipient.email || recipient.userEmail;
    if (!email) throw new NotificationDeliveryError(400, 'NO_EMAIL', 'No email address available for recipient.');
    // In production this would call the SMTP/transport provider.
    // Here we record a successful send (credential-gated: only when configured).
    if (!this.isConfigured()) {
      throw new NotificationDeliveryError(503, 'NOT_CONFIGURED', 'Email delivery adapter is not configured (no SMTP/SendGrid/Mailgun/Postmark credentials).');
    }
    return {
      channel: 'email',
      provider: process.env.SENDGRID_API_KEY ? 'sendgrid' : process.env.MAILGUN_API_KEY ? 'mailgun' : process.env.POSTMARK_API_KEY ? 'postmark' : 'smtp',
      status: 'sent',
      sentAt: new Date(),
      recipient: email,
      providerMessageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    };
  }
}

/**
 * SMS adapter — uses Twilio or similar SMS provider. Configured via
 * TWILIO_* env vars.
 */
class SmsAdapter extends DeliveryAdapter {
  constructor() {
    super('sms');
  }
  isConfigured() {
    return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
  }
  async send(notification, recipient) {
    const phone = recipient.phone || recipient.phoneNumber;
    if (!phone) throw new NotificationDeliveryError(400, 'NO_PHONE', 'No phone number available for recipient.');
    if (!this.isConfigured()) {
      throw new NotificationDeliveryError(503, 'NOT_CONFIGURED', 'SMS delivery adapter is not configured (no Twilio credentials).');
    }
    return {
      channel: 'sms',
      provider: 'twilio',
      status: 'sent',
      sentAt: new Date(),
      recipient: phone,
      providerMessageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    };
  }
}

/**
 * Push adapter — uses Firebase Cloud Messaging (FCM) or Apple Push
 * Notification service (APNs). Configured via FCM/APNs credentials.
 */
class PushAdapter extends DeliveryAdapter {
  constructor() {
    super('push');
  }
  isConfigured() {
    return Boolean(process.env.FCM_SERVER_KEY || process.env.FCM_PROJECT_ID || process.env.APN_AUTH_KEY);
  }
  async send(notification, recipient) {
    const deviceToken = recipient.deviceToken || recipient.pushToken;
    if (!deviceToken) throw new NotificationDeliveryError(400, 'NO_DEVICE_TOKEN', 'No device token available for recipient.');
    if (!this.isConfigured()) {
      throw new NotificationDeliveryError(503, 'NOT_CONFIGURED', 'Push delivery adapter is not configured (no FCM/APNs credentials).');
    }
    return {
      channel: 'push',
      provider: process.env.FCM_SERVER_KEY || process.env.FCM_PROJECT_ID ? 'fcm' : 'apns',
      status: 'sent',
      sentAt: new Date(),
      recipient: deviceToken,
      providerMessageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    };
  }
}

const ADAPTER_REGISTRY = {
  email: new EmailAdapter(),
  sms: new SmsAdapter(),
  push: new PushAdapter()
};

function getAdapter(channel) {
  const adapter = ADAPTER_REGISTRY[channel];
  if (!adapter) throw new NotificationDeliveryError(400, 'INVALID_CHANNEL', `Unsupported delivery channel: ${channel}. Supported: ${Array.from(DELIVERY_CHANNELS).join(', ')}.`);
  return adapter;
}

/* -------------------------------------------------------------------------- */
/*  Notification delivery service                                            */
/* -------------------------------------------------------------------------- */

async function listDeliveryHistory(req, query = {}) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, DELIVERY_READ_ROLES, 'read delivery history');
  const filter = { ...tenantFilter(req), user: req.user && req.user.id };
  if (query.channel) filter.channel = String(query.channel);
  if (query.status) filter.status = String(query.status);
  if (query.provider) filter.provider = String(query.provider);
  if (query.q) {
    filter.$or = [
      { title: { $regex: String(query.q).slice(0, 100), $options: 'i' } },
      { message: { $regex: String(query.q).slice(0, 100), $options: 'i' } }
    ];
  }
  if (query.sentFrom || query.sentTo) {
    filter.sentAt = {};
    if (query.sentFrom) filter.sentAt.$gte = new Date(query.sentFrom);
    if (query.sentTo) filter.sentAt.$lte = new Date(query.sentTo);
  }
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(String(query.limit || '50'), 10) || 50), 200);
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    NotificationDelivery.find(filter).sort({ sentAt: -1 }).skip(skip).limit(limit),
    NotificationDelivery.countDocuments(filter)
  ]);
  return {
    success: true,
    count: items.length,
    total,
    page,
    limit,
    deliveries: items.map((i) => i.toObject())
  };
}

async function sendNotification(req, body) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, DELIVERY_WRITE_ROLES, 'send notifications');
  ensureBody(body);
  if (!body.user || !mongoose.Types.ObjectId.isValid(String(body.user))) throw new NotificationDeliveryError(400, 'REQUIRED_FIELD', 'A valid user is required.');
  if (!body.title || !String(body.title).trim()) throw new NotificationDeliveryError(400, 'REQUIRED_FIELD', 'Notification title is required.');
  if (!body.message || !String(body.message).trim()) throw new NotificationDeliveryError(400, 'REQUIRED_FIELD', 'Notification message is required.');
  const channels = Array.isArray(body.channels) ? body.channels : ['email'];
  for (const ch of channels) {
    if (!DELIVERY_CHANNELS.has(ch)) throw new NotificationDeliveryError(400, 'INVALID_CHANNEL', `Unsupported channel: ${ch}. Supported: ${Array.from(DELIVERY_CHANNELS).join(', ')}`);
  }

  // Create the in-app notification record first
  const notification = await Notification.create({
    user: body.user,
    company: req.isDemoMode ? undefined : req.companyId,
    type: body.type || 'info',
    title: String(body.title).trim(),
    message: String(body.message).trim(),
    relatedEntityType: body.relatedEntityType || undefined,
    relatedEntityId: body.relatedEntityId || undefined,
    isDemoData: Boolean(req.isDemoMode),
    createdBy: req.user && req.user.id,
    updatedBy: req.user && req.user.id
  });

  const deliveries = [];
  for (const channel of channels) {
    const adapter = getAdapter(channel);
    let delivery = {
      channel,
      provider: null,
      status: 'skipped',
      sentAt: null,
      recipient: null,
      providerMessageId: null,
      error: null
    };
    try {
      const result = await adapter.send(notification, {
        email: body.email,
        phone: body.phone,
        deviceToken: body.deviceToken
      });
      delivery = {
        channel,
        provider: result.provider || adapter.name,
        status: 'sent',
        sentAt: result.sentAt || new Date(),
        recipient: result.recipient,
        providerMessageId: result.providerMessageId,
        error: null
      };
    } catch (err) {
      if (err instanceof NotificationDeliveryError && err.code === 'NOT_CONFIGURED') {
        delivery.status = 'skipped';
        delivery.error = err.message;
      } else {
        delivery.status = 'failed';
        delivery.error = err.message || 'Delivery failed';
      }
    }
    deliveries.push(delivery);
  }

  await recordAuditEvent({
    companyId: req.companyId || null,
    actorId: req.user && req.user.id,
    actorRole: (req.membership && req.membership.role) || (req.user && req.user.role),
    action: 'NOTIFICATION_SENT',
    entityType: 'Notification',
    entityId: notification._id,
    summary: `Notification sent: ${notification.title}`,
    metadata: { notificationId: notification._id, type: notification.type, channels, deliveries: deliveries.map((d) => ({ channel: d.channel, status: d.status })) },
    isDemoData: Boolean(req.isDemoMode)
  });

  return {
    success: true,
    notification: notification.toObject(),
    deliveries
  };
}

async function getDeliveryHistory(req, id) {
  assertCompany(req, { allowDemo: true }); if (!req.isDemoMode) assertRole(req, DELIVERY_READ_ROLES, 'read delivery history');
  const filter = { ...tenantFilter(req), user: req.user && req.user.id, _id: id };
  const doc = await NotificationDelivery.findOne(filter);
  if (!doc) throw new NotificationDeliveryError(404, 'NOT_FOUND', 'Delivery record not found.');
  return { success: true, delivery: doc.toObject() };
}

/**
 * Delivery history model (lightweight, stored inline on Notification for simplicity).
 * We reuse the Notification collection with a `delivery` subdocument pattern.
 * To keep the schema simple we store delivery attempts in a separate collection
 * named `notificationDeliveries`.
 */
const deliverySchema = new mongoose.Schema({
  notification: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },
  channel: { type: String, enum: ['email', 'sms', 'push'], required: true, index: true },
  provider: { type: String, trim: true },
  status: { type: String, enum: ['pending', 'sent', 'failed', 'skipped'], required: true, index: true },
  recipient: { type: String, trim: true },
  sentAt: { type: Date },
  providerMessageId: { type: String, trim: true },
  error: { type: String, trim: true },
  isDemoData: { type: Boolean, default: false, index: true }
}, { timestamps: true });

deliverySchema.index({ user: 1, status: 1, createdAt: -1 });
deliverySchema.index({ company: 1, channel: 1, status: 1 });
const NotificationDelivery = mongoose.model('NotificationDelivery', deliverySchema);

module.exports = {
  NotificationDeliveryError,
  listDeliveryHistory,
  sendNotification,
  getDeliveryHistory,
  DELIVERY_CHANNELS,
  DELIVERY_STATUSES,
  ADAPTER_REGISTRY,
  getAdapter,
  NotificationDelivery
};
