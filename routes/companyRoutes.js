const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const User = require('../models/User');
const Company = require('../models/Company');
const Membership = require('../models/Membership');
const { recordAuditEvent, listAuditEvents } = require('../services/auditService');
const { createInvitation, listInvitations, revokeInvitation, acceptInvitation, InvitationError } = require('../services/invitationService');

const MANAGE_ROLES = new Set(['broker_owner', 'broker_admin', 'carrier_owner', 'carrier_admin', 'platform_admin']);
const COMPANY_TYPES = new Set(['brokerage', 'carrier', 'platform']);
const MEMBER_ROLES_BY_COMPANY_TYPE = {
  brokerage: new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer']),
  carrier: new Set(['carrier_owner', 'carrier_admin', 'dispatcher', 'driver', 'viewer']),
  platform: new Set(['platform_admin', 'platform_support', 'viewer'])
};

const assertObjectId = (value, res, label, code = 'INVALID_ID') => {
  if (!mongoose.Types.ObjectId.isValid(String(value || ''))) {
    res.status(400).json({ success: false, error: `${label} must be a valid ObjectId`, code });
    return false;
  }
  return true;
};

const denyDemo = (req, res) => {
  const explicitDemo = req.headers['x-demo-mode'] === 'true' || req.query.demo === 'true';
  if (req.isDemoMode || explicitDemo) {
    res.status(403).json({ success: false, error: 'Company management is not available in demo mode', code: 'DEMO_NOT_ALLOWED' });
    return true;
  }
  return false;
};

const requireCompanyManager = (req, res) => {
  if (denyDemo(req, res)) return false;
  if (!req.companyId || !req.membership || !req.user) {
    res.status(403).json({ success: false, error: 'Verified active company context is required', code: 'COMPANY_CONTEXT_REQUIRED' });
    return false;
  }
  const role = req.membership.role;
  const isOwner = req.company && req.company.owner && String(req.company.owner) === String(req.user.id);
  if (!isOwner && !MANAGE_ROLES.has(role)) {
    res.status(403).json({ success: false, error: 'Not authorized to manage this company', code: 'FORBIDDEN_COMPANY_ROLE' });
    return false;
  }
  return true;
};

const toPublicMembership = (membership) => ({
  id: String(membership._id),
  userId: membership.user && membership.user._id ? String(membership.user._id) : String(membership.user),
  name: membership.user && membership.user.name ? membership.user.name : undefined,
  email: membership.user && membership.user.email ? membership.user.email : undefined,
  role: membership.role,
  isActive: membership.isActive,
  joinedAt: membership.joinedAt
});

const handleInvitationError = (error, res, next) => {
  if (error instanceof InvitationError) {
    return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
  }
  return next(error);
};

// Accept invitation by token for authenticated user (not company-scoped by path)
router.post('/invitations/accept', requireAuth, async (req, res, next) => {
  try {
    if (req.headers['x-demo-mode'] === 'true' || req.query.demo === 'true') {
      return res.status(403).json({ success: false, error: 'Invitation acceptance is not available in demo mode', code: 'DEMO_NOT_ALLOWED' });
    }
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const result = await acceptInvitation({ token, user: req.user });
    return res.json({
      success: true,
      company: {
        id: String(result.company._id),
        name: result.company.name,
        type: result.company.type,
        slug: result.company.slug,
        status: result.company.status
      },
      membership: toPublicMembership(await Membership.findById(result.membership._id).populate('user', 'name email'))
    });
  } catch (error) {
    return handleInvitationError(error, res, next);
  }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const memberships = await Membership.find({ user: req.user.id, isActive: true })
      .populate('company', 'name type slug status owner');
    const companies = memberships
      .map((m) => m.company)
      .filter(Boolean)
      .map((company) => ({
        id: String(company._id),
        name: company.name,
        type: company.type,
        slug: company.slug,
        status: company.status,
        owner: company.owner ? String(company.owner) : null
      }));
    return res.json({ success: true, companies });
  } catch (error) {
    return next(error);
  }
});

router.get('/:companyId', requireAuth, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.companyId, res, 'companyId')) return;
    const membership = await Membership.findOne({
      company: req.params.companyId,
      user: req.user.id,
      isActive: true
    }).populate('company');
    if (!membership || !membership.company) {
      return res.status(403).json({ success: false, error: 'Not a member of this company', code: 'NOT_A_MEMBER' });
    }
    return res.json({ success: true, company: membership.company, membership: toPublicMembership(membership) });
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const allowed = new Set(['name', 'type']);
    const unknown = Object.keys(body).filter((k) => !allowed.has(k));
    if (unknown.length) {
      return res.status(400).json({ success: false, error: `Unsupported fields: ${unknown.join(', ')}`, code: 'INVALID_FIELDS' });
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ success: false, error: 'Company name is required', code: 'REQUIRED_FIELD' });
    }
    const type = typeof body.type === 'string' ? body.type.trim().toLowerCase() : 'brokerage';
    if (!COMPANY_TYPES.has(type)) {
      return res.status(400).json({ success: false, error: 'Invalid company type', code: 'INVALID_FIELD' });
    }
    const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'company';
    const slug = `${slugBase}-${Date.now().toString(36)}`;
    const company = await Company.create({
      name,
      slug,
      type,
      owner: req.user.id,
      createdBy: req.user.id
    });
    const ownerRole = type === 'carrier' ? 'carrier_owner' : type === 'platform' ? 'platform_admin' : 'broker_owner';
    const membership = await Membership.create({
      user: req.user.id,
      company: company._id,
      role: ownerRole,
      isActive: true
    });
    await recordAuditEvent({
      companyId: company._id,
      actorId: req.user.id,
      actorRole: ownerRole,
      action: 'COMPANY_CREATED',
      entityType: 'Company',
      entityId: company._id,
      summary: `Company created: ${company.name}`,
      metadata: { name: company.name, type: company.type }
    });
    return res.status(201).json({ success: true, company, membership: toPublicMembership(membership) });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:companyId', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.companyId, res, 'companyId')) return;
    if (String(req.companyId) !== String(req.params.companyId)) {
      return res.status(403).json({ success: false, error: 'Active company context does not match requested company', code: 'COMPANY_CONTEXT_MISMATCH' });
    }
    if (!requireCompanyManager(req, res)) return;
    const body = req.body || {};
    const allowed = new Set(['name']);
    const unknown = Object.keys(body).filter((k) => !allowed.has(k));
    if (unknown.length) {
      return res.status(400).json({ success: false, error: `Unsupported fields: ${unknown.join(', ')}`, code: 'INVALID_FIELDS' });
    }
    const company = await Company.findById(req.companyId);
    if (!company) {
      return res.status(404).json({ success: false, error: 'Company not found', code: 'COMPANY_NOT_FOUND' });
    }
    const changes = {};
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return res.status(400).json({ success: false, error: 'Company name cannot be empty', code: 'INVALID_FIELD' });
      if (name !== company.name) changes.name = { from: company.name, to: name };
      company.name = name;
    }
    company.updatedAt = new Date();
    await company.save();
    if (Object.keys(changes).length) {
      await recordAuditEvent({
        companyId: company._id,
        actorId: req.user.id,
        actorRole: req.membership?.role,
        action: 'COMPANY_UPDATED',
        entityType: 'Company',
        entityId: company._id,
        summary: 'Company updated',
        changes,
        isDemoData: Boolean(req.isDemoMode)
      });
    }
    return res.json({ success: true, company });
  } catch (error) {
    return next(error);
  }
});

router.post('/:companyId/members', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.companyId, res, 'companyId')) return;
    if (String(req.companyId) !== String(req.params.companyId)) {
      return res.status(403).json({ success: false, error: 'Active company context does not match requested company', code: 'COMPANY_CONTEXT_MISMATCH' });
    }
    if (!requireCompanyManager(req, res)) return;
    const body = req.body || {};
    const allowed = new Set(['userId', 'role']);
    const unknown = Object.keys(body).filter((k) => !allowed.has(k));
    if (unknown.length) {
      return res.status(400).json({ success: false, error: `Unsupported fields: ${unknown.join(', ')}`, code: 'INVALID_FIELDS' });
    }
    const { userId, role } = body;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required', code: 'REQUIRED_FIELD' });
    }
    if (!assertObjectId(userId, res, 'userId')) return;
    const company = req.company || await Company.findById(req.companyId);
    if (!company) return res.status(404).json({ success: false, error: 'Company not found', code: 'COMPANY_NOT_FOUND' });
    const targetUser = await User.findById(userId);
    if (!targetUser) {
      return res.status(404).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    const existing = await Membership.findOne({ user: userId, company: req.companyId });
    if (existing) {
      return res.status(409).json({ success: false, error: 'User is already a member of this company', code: 'MEMBERSHIP_EXISTS' });
    }
    const allowedRoles = MEMBER_ROLES_BY_COMPANY_TYPE[company.type] || MEMBER_ROLES_BY_COMPANY_TYPE.brokerage;
    const requestedRole = typeof role === 'string' ? role.trim() : '';
    const defaultRole = company.type === 'carrier' ? 'driver' : 'broker';
    const memberRole = requestedRole || defaultRole;
    if (!allowedRoles.has(memberRole)) {
      return res.status(400).json({ success: false, error: 'Invalid role for this company type', code: 'INVALID_ROLE' });
    }
    const membership = await Membership.create({
      user: userId,
      company: req.companyId,
      role: memberRole,
      isActive: true
    });
    const populated = await Membership.findById(membership._id).populate('user', 'name email');
    await recordAuditEvent({
      companyId: req.companyId,
      actorId: req.user.id,
      actorRole: req.membership?.role,
      action: 'MEMBERSHIP_CREATED',
      entityType: 'Membership',
      entityId: membership._id,
      summary: `Member added: ${targetUser.email}`,
      metadata: { userId: String(userId), role: memberRole },
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.status(201).json({ success: true, membership: toPublicMembership(populated) });
  } catch (error) {
    return next(error);
  }
});

router.get('/:companyId/members', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.companyId, res, 'companyId')) return;
    if (String(req.companyId) !== String(req.params.companyId)) {
      return res.status(403).json({ success: false, error: 'Active company context does not match requested company', code: 'COMPANY_CONTEXT_MISMATCH' });
    }
    if (!requireCompanyManager(req, res)) return;
    const memberships = await Membership.find({ company: req.companyId, isActive: true })
      .populate('user', 'name email')
      .sort({ joinedAt: -1 });
    const members = memberships.map(toPublicMembership);
    return res.json({ success: true, members });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:companyId/members/:membershipId', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.companyId, res, 'companyId')) return;
    if (!assertObjectId(req.params.membershipId, res, 'membershipId')) return;
    if (String(req.companyId) !== String(req.params.companyId)) {
      return res.status(403).json({ success: false, error: 'Active company context does not match requested company', code: 'COMPANY_CONTEXT_MISMATCH' });
    }
    if (!requireCompanyManager(req, res)) return;
    const body = req.body || {};
    const allowed = new Set(['role']);
    const unknown = Object.keys(body).filter((k) => !allowed.has(k));
    if (unknown.length) {
      return res.status(400).json({ success: false, error: `Unsupported fields: ${unknown.join(', ')}`, code: 'INVALID_FIELDS' });
    }
    const role = typeof body.role === 'string' ? body.role.trim() : '';
    if (!role) return res.status(400).json({ success: false, error: 'role is required', code: 'REQUIRED_FIELD' });

    const company = req.company || await Company.findById(req.companyId);
    if (!company) return res.status(404).json({ success: false, error: 'Company not found', code: 'COMPANY_NOT_FOUND' });
    const membership = await Membership.findOne({
      _id: req.params.membershipId,
      company: req.companyId,
      isActive: true
    }).populate('user', 'name email');
    if (!membership) {
      return res.status(404).json({ success: false, error: 'Membership not found', code: 'MEMBERSHIP_NOT_FOUND' });
    }

    const allowedRoles = MEMBER_ROLES_BY_COMPANY_TYPE[company.type] || MEMBER_ROLES_BY_COMPANY_TYPE.brokerage;
    if (!allowedRoles.has(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role for this company type', code: 'INVALID_ROLE' });
    }

    const ownerId = company.owner ? String(company.owner) : null;
    const targetUserId = membership.user && membership.user._id ? String(membership.user._id) : String(membership.user);
    const isOwnerMembership = ownerId && targetUserId === ownerId;
    const previousRole = membership.role;
    if (isOwnerMembership) {
      const ownerRoleForType = company.type === 'carrier' ? 'carrier_owner' : company.type === 'platform' ? 'platform_admin' : 'broker_owner';
      if (role !== ownerRoleForType) {
        const ownerCount = await Membership.countDocuments({
          company: req.companyId,
          user: ownerId,
          isActive: true
        });
        if (ownerCount <= 1) {
          return res.status(403).json({ success: false, error: 'Cannot demote the final company owner membership', code: 'FINAL_OWNER_REQUIRED' });
        }
      }
    }

    membership.role = role;
    await membership.save();
    const populated = await Membership.findById(membership._id).populate('user', 'name email');
    if (previousRole !== role) {
      await recordAuditEvent({
        companyId: req.companyId,
        actorId: req.user.id,
        actorRole: req.membership?.role,
        action: 'MEMBERSHIP_ROLE_UPDATED',
        entityType: 'Membership',
        entityId: membership._id,
        summary: 'Member role updated',
        changes: { role: { from: previousRole, to: role } },
        metadata: { userId: targetUserId },
        isDemoData: Boolean(req.isDemoMode)
      });
    }
    return res.json({ success: true, membership: toPublicMembership(populated) });
  } catch (error) {
    return next(error);
  }
});

router.delete('/:companyId/members/:membershipId', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.companyId, res, 'companyId')) return;
    if (!assertObjectId(req.params.membershipId, res, 'membershipId')) return;
    if (String(req.companyId) !== String(req.params.companyId)) {
      return res.status(403).json({ success: false, error: 'Active company context does not match requested company', code: 'COMPANY_CONTEXT_MISMATCH' });
    }
    if (!requireCompanyManager(req, res)) return;
    const company = req.company || await Company.findById(req.companyId);
    if (!company) return res.status(404).json({ success: false, error: 'Company not found', code: 'COMPANY_NOT_FOUND' });
    const membership = await Membership.findOne({ _id: req.params.membershipId, company: req.companyId, isActive: true });
    if (!membership) {
      return res.status(404).json({ success: false, error: 'Membership not found', code: 'MEMBERSHIP_NOT_FOUND' });
    }

    const ownerId = company.owner ? String(company.owner) : null;
    const targetUserId = String(membership.user);
    if (ownerId && targetUserId === ownerId) {
      const activeOwnerMemberships = await Membership.countDocuments({
        company: req.companyId,
        user: ownerId,
        isActive: true
      });
      if (activeOwnerMemberships <= 1) {
        return res.status(403).json({ success: false, error: 'Cannot remove the final company owner', code: 'FINAL_OWNER_REQUIRED' });
      }
    }

    membership.isActive = false;
    await membership.save();
    await recordAuditEvent({
      companyId: req.companyId,
      actorId: req.user.id,
      actorRole: req.membership?.role,
      action: 'MEMBERSHIP_REMOVED',
      entityType: 'Membership',
      entityId: membership._id,
      summary: 'Member removed',
      metadata: { userId: targetUserId, role: membership.role },
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.json({ success: true, message: 'Member removed successfully' });
  } catch (error) {
    return next(error);
  }
});

// Invitations (company-scoped, manager-only)
router.get('/:companyId/invitations', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.companyId, res, 'companyId')) return;
    if (String(req.companyId) !== String(req.params.companyId)) {
      return res.status(403).json({ success: false, error: 'Active company context does not match requested company', code: 'COMPANY_CONTEXT_MISMATCH' });
    }
    if (!requireCompanyManager(req, res)) return;
    const includeAll = String(req.query.include || '').toLowerCase() === 'all' || req.query.all === 'true';
    const invitations = await listInvitations({ companyId: req.companyId, includeAll });
    return res.json({ success: true, invitations });
  } catch (error) {
    return handleInvitationError(error, res, next);
  }
});

router.post('/:companyId/invitations', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.companyId, res, 'companyId')) return;
    if (String(req.companyId) !== String(req.params.companyId)) {
      return res.status(403).json({ success: false, error: 'Active company context does not match requested company', code: 'COMPANY_CONTEXT_MISMATCH' });
    }
    if (!requireCompanyManager(req, res)) return;
    const body = req.body || {};
    const allowed = new Set(['email', 'role', 'expiresInDays', 'message']);
    const unknown = Object.keys(body).filter((k) => !allowed.has(k));
    if (unknown.length) {
      return res.status(400).json({ success: false, error: `Unsupported fields: ${unknown.join(', ')}`, code: 'INVALID_FIELDS' });
    }
    const company = req.company || await Company.findById(req.companyId);
    if (!company) return res.status(404).json({ success: false, error: 'Company not found', code: 'COMPANY_NOT_FOUND' });
    const { invitation, token } = await createInvitation({
      company,
      actor: req.user,
      email: body.email,
      role: body.role,
      expiresInDays: body.expiresInDays,
      message: body.message,
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.status(201).json({
      success: true,
      invitation: {
        id: String(invitation._id),
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt
      },
      // Token returned once for delivery by caller/integration (email delivery adapter may be credential-gated).
      token
    });
  } catch (error) {
    return handleInvitationError(error, res, next);
  }
});

router.post('/:companyId/invitations/:invitationId/revoke', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.companyId, res, 'companyId')) return;
    if (!assertObjectId(req.params.invitationId, res, 'invitationId')) return;
    if (String(req.companyId) !== String(req.params.companyId)) {
      return res.status(403).json({ success: false, error: 'Active company context does not match requested company', code: 'COMPANY_CONTEXT_MISMATCH' });
    }
    if (!requireCompanyManager(req, res)) return;
    const invitation = await revokeInvitation({
      companyId: req.companyId,
      invitationId: req.params.invitationId,
      actor: req.user,
      isDemoData: Boolean(req.isDemoMode)
    });
    return res.json({ success: true, invitation: { id: String(invitation._id), email: invitation.email, role: invitation.role, status: invitation.status, revokedAt: invitation.revokedAt } });
  } catch (error) {
    return handleInvitationError(error, res, next);
  }
});

// Audit events (company-scoped, manager-only)
router.get('/:companyId/audit-events', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    if (!assertObjectId(req.params.companyId, res, 'companyId')) return;
    if (String(req.companyId) !== String(req.params.companyId)) {
      return res.status(403).json({ success: false, error: 'Active company context does not match requested company', code: 'COMPANY_CONTEXT_MISMATCH' });
    }
    if (!requireCompanyManager(req, res)) return;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType.trim() : undefined;
    const entityId = typeof req.query.entityId === 'string' ? req.query.entityId.trim() : undefined;
    const events = await listAuditEvents({ companyId: req.companyId, entityType, entityId, limit });
    return res.json({ success: true, events: events.map((e) => ({
      id: String(e._id),
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId || null,
      summary: e.summary || null,
      changes: e.changes || null,
      metadata: e.metadata || null,
      severity: e.severity || 'info',
      actor: e.actor ? { id: String(e.actor._id || e.actor), name: e.actor.name, email: e.actor.email } : null,
      actorRole: e.actorRole || null,
      occurredAt: e.occurredAt || e.createdAt
    })) });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
