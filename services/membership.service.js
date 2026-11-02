const Membership = require('../models/Membership');
const Company = require('../models/Company');

/**
 * Membership lookup service.
 */
export async function getMembership(userId, companyId) {
  return await Membership.findOne({ user: userId, company: companyId });
}

/**
 * Company membership listing service.
 */
export async function listUserMemberships(userId) {
  return await Membership.find({ user: userId, isActive: true })
    .populate('company', 'name slug type status');
}

/**
 * Membership activation and suspension service.
 */
export async function toggleMembershipStatus(membershipId, active) {
  return await Membership.findByIdAndUpdate(membershipId, { isActive: active }, { new: true });
}

/**
 * Check if user has a specific role in a company.
 */
export async function hasMembershipRole(userId, companyId, role) {
  const membership = await Membership.findOne({ user: userId, company: companyId, isActive: true });
  if (!membership) return false;
  return membership.permissions.includes(role) || membership.role === role;
}
