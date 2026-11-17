const crypto = require('crypto');
const mongoose = require('mongoose');
const Invitation = require('../models/Invitation');
const Membership = require('../models/Membership');
const Company = require('../models/Company');
const User = require('../models/User');
const { recordAuditEvent } = require('./auditService');

const MEMBER_ROLES_BY_COMPANY_TYPE = {
  brokerage: new Set(['broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer', 'finance', 'viewer']),
  carrier: new Set(['carrier_owner', 'carrier_admin', 'dispatcher', 'driver', 'viewer']),
  platform: new Set(['platform_admin', 'platform_support', 'viewer'])
};

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

class InvitationError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function assertObjectId(id, label = 'id') {
  if (!mongoose.Types.ObjectId.isValid(String(id || ''))) {
    throw new InvitationError(400, 'INVALID_ID', `${label} must be a valid ObjectId`);
  }
}

function allowedRolesForCompany(company) {
  return MEMBER_ROLES_BY_COMPANY_TYPE[company.type] || MEMBER_ROLES_BY_COMPANY_TYPE.brokerage;
}

async function createInvitation({ company, actor, email, role, expiresInDays = 7, message = null, isDemoData = false }) {
  if (!company || !company._id) throw new InvitationError(400, 'COMPANY_REQUIRED', 'Company context is required');
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new InvitationError(400, 'INVALID_EMAIL', 'A valid email is required');
  }
  const roles = allowedRolesForCompany(company);
  const normalizedRole = typeof role === 'string' ? role.trim() : '';
  if (!normalizedRole || !roles.has(normalizedRole)) {
    throw new InvitationError(400, 'INVALID_ROLE', 'Invalid role for this company type');
  }

  const existingMember = await Membership.findOne({ company: company._id, isActive: true })
    .populate({ path: 'user', match: { email: normalizedEmail }, select: '_id email' });
  if (existingMember && existingMember.user) {
    throw new InvitationError(409, 'MEMBERSHIP_EXISTS', 'User is already a member of this company');
  }

  const days = Math.max(1, Math.min(30, Number(expiresInDays) || 7));
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const rawToken = crypto.randomBytes(24).toString('hex');

  // Revoke prior pending invitations for same company/email to avoid ambiguity
  await Invitation.updateMany(
    { company: company._id, email: normalizedEmail, status: 'pending' },
    { $set: { status: 'revoked', revokedAt: new Date() } }
  );

  const invitation = await Invitation.create({
    company: company._id,
    email: normalizedEmail,
    role: normalizedRole,
    tokenHash: hashToken(rawToken),
    status: 'pending',
    invitedBy: actor && actor.id ? actor.id : undefined,
    expiresAt,
    message: message ? String(message).slice(0, 500) : undefined,
    isDemoData: Boolean(isDemoData)
  });

  await recordAuditEvent({
    companyId: company._id,
    actorId: actor && actor.id,
    actorRole: actor && actor.role,
    action: 'INVITATION_CREATED',
    entityType: 'Invitation',
    entityId: invitation._id,
    summary: `Invitation created for ${normalizedEmail}`,
    metadata: { email: normalizedEmail, role: normalizedRole, expiresAt },
    isDemoData: Boolean(isDemoData)
  });

  return { invitation, token: rawToken };
}

async function listInvitations({ companyId, includeAll = false }) {
  assertObjectId(companyId, 'companyId');
  // Persist expiry for pending invitations so lifecycle state is consistent.
  await Invitation.updateMany(
    { company: companyId, status: 'pending', expiresAt: { $lt: new Date() } },
    { $set: { status: 'expired' } }
  );
  const filter = { company: companyId };
  if (!includeAll) filter.status = { $in: ['pending', 'expired'] };
  const invites = await Invitation.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('invitedBy', 'name email')
    .lean();

  return invites.map((inv) => ({
    id: String(inv._id),
    email: inv.email,
    role: inv.role,
    status: inv.status,
    expiresAt: inv.expiresAt,
    invitedBy: inv.invitedBy ? { id: String(inv.invitedBy._id || inv.invitedBy), name: inv.invitedBy.name, email: inv.invitedBy.email } : null,
    createdAt: inv.createdAt,
    revokedAt: inv.revokedAt || null,
    acceptedAt: inv.acceptedAt || null
  }));
}

async function revokeInvitation({ companyId, invitationId, actor, isDemoData = false }) {
  assertObjectId(companyId, 'companyId');
  assertObjectId(invitationId, 'invitationId');
  const invitation = await Invitation.findOne({ _id: invitationId, company: companyId });
  if (!invitation) throw new InvitationError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
  if (invitation.status !== 'pending') {
    throw new InvitationError(409, 'INVITATION_NOT_PENDING', 'Only pending invitations can be revoked');
  }
  invitation.status = 'revoked';
  invitation.revokedAt = new Date();
  await invitation.save();
  await recordAuditEvent({
    companyId,
    actorId: actor && actor.id,
    actorRole: actor && actor.role,
    action: 'INVITATION_REVOKED',
    entityType: 'Invitation',
    entityId: invitation._id,
    summary: `Invitation revoked for ${invitation.email}`,
    metadata: { email: invitation.email, role: invitation.role },
    isDemoData: Boolean(isDemoData)
  });
  return invitation;
}

async function acceptInvitation({ token, user }) {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) throw new InvitationError(400, 'INVALID_TOKEN', 'Invitation token is required');
  if (!user || !user.id) throw new InvitationError(401, 'AUTH_REQUIRED', 'Authentication required');

  const invitation = await Invitation.findOne({ tokenHash: hashToken(raw) }).populate('company');
  if (!invitation) throw new InvitationError(404, 'INVITATION_NOT_FOUND', 'Invitation not found or invalid');
  if (invitation.status !== 'pending') {
    throw new InvitationError(409, 'INVITATION_NOT_PENDING', `Invitation is ${invitation.status}`);
  }
  if (invitation.expiresAt && invitation.expiresAt.getTime() < Date.now()) {
    invitation.status = 'expired';
    await invitation.save();
    throw new InvitationError(410, 'INVITATION_EXPIRED', 'Invitation has expired');
  }
  const company = invitation.company || await Company.findById(invitation.company);
  if (!company) throw new InvitationError(404, 'COMPANY_NOT_FOUND', 'Company not found');

  const currentUser = await User.findById(user.id);
  if (!currentUser) throw new InvitationError(401, 'USER_NOT_FOUND', 'Authenticated user not found');
  const emailMatches = String(currentUser.email || '').toLowerCase() === String(invitation.email || '').toLowerCase();
  if (!emailMatches) {
    throw new InvitationError(403, 'INVITATION_EMAIL_MISMATCH', 'Invitation email does not match authenticated user');
  }

  const roles = allowedRolesForCompany(company);
  if (!roles.has(invitation.role)) {
    throw new InvitationError(400, 'INVALID_ROLE', 'Invitation role is no longer valid for this company');
  }

  let membership = await Membership.findOne({ user: currentUser._id, company: company._id });
  if (membership) {
    if (membership.isActive) {
      invitation.status = 'accepted';
      invitation.acceptedBy = currentUser._id;
      invitation.acceptedAt = new Date();
      await invitation.save();
      throw new InvitationError(409, 'MEMBERSHIP_EXISTS', 'User is already a member of this company');
    }
    membership.isActive = true;
    membership.role = invitation.role;
    await membership.save();
  } else {
    membership = await Membership.create({
      user: currentUser._id,
      company: company._id,
      role: invitation.role,
      isActive: true
    });
  }

  invitation.status = 'accepted';
  invitation.acceptedBy = currentUser._id;
  invitation.acceptedAt = new Date();
  await invitation.save();

  await recordAuditEvent({
    companyId: company._id,
    actorId: currentUser._id,
    actorRole: membership.role,
    action: 'INVITATION_ACCEPTED',
    entityType: 'Invitation',
    entityId: invitation._id,
    summary: `Invitation accepted for ${invitation.email}`,
    metadata: { email: invitation.email, role: invitation.role, membershipId: String(membership._id) },
    isDemoData: Boolean(invitation.isDemoData)
  });

  return { invitation, membership, company };
}

module.exports = {
  InvitationError,
  createInvitation,
  listInvitations,
  revokeInvitation,
  acceptInvitation
};
