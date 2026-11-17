const Membership = require('../models/Membership');

/**
 * Membership lookup service.
 */
async function getMembership(userId, companyId) {
  return Membership.findOne({ user: userId, company: companyId });
}

/**
 * Company membership listing service.
 */
async function listUserMemberships(userId) {
  return Membership.find({ user: userId, isActive: true })
    .populate('company', 'name slug type status');
}

/**
 * Membership activation and suspension service.
 */
async function toggleMembershipStatus(membershipId, active) {
  return Membership.findByIdAndUpdate(membershipId, { isActive: Boolean(active) }, { new: true });
}

/**
 * Check if user has a specific role or permission in a company.
 */
async function hasMembershipRole(userId, companyId, role) {
  const membership = await Membership.findOne({ user: userId, company: companyId, isActive: true });
  if (!membership) return false;
  return (membership.permissions || []).includes(role) || membership.role === role;
}

module.exports = {
  getMembership,
  listUserMemberships,
  toggleMembershipStatus,
  hasMembershipRole
};
