const Company = require('../models/Company');
const Membership = require('../models/Membership');

/**
 * Company creation service.
 * Validates input, creates company, and enrolls the creator as owner.
 */
async function createCompany(creatorId, companyData = {}) {
  if (!companyData.name) {
    const error = new Error('Company name is required');
    error.status = 400;
    throw error;
  }
  const slugValue = typeof companyData.slug === 'string' ? companyData.slug.trim().toLowerCase() : '';
  if (!slugValue) {
    const error = new Error('Company slug is required');
    error.status = 400;
    throw error;
  }

  const existing = await Company.findOne({ slug: slugValue });
  if (existing) {
    const error = new Error('A company with this slug already exists');
    error.status = 409;
    throw error;
  }

  const companyDataTrimmed = {
    name: String(companyData.name).trim(),
    slug: slugValue,
    type: companyData.type || 'brokerage',
    status: companyData.status || 'pending',
    owner: creatorId,
    createdBy: creatorId,
    contact: companyData.contact || {}
  };

  const company = await Company.create(companyDataTrimmed);

  await Membership.create({
    user: creatorId,
    company: company._id,
    role: company.type === 'carrier' ? 'carrier_owner' : company.type === 'platform' ? 'platform_admin' : 'broker_owner',
    isActive: true
  });

  return company;
}

/**
 * Membership creation service.
 * Validates role compatibility with company type.
 */
async function createMembership(userId, companyId, role) {
  const company = await Company.findById(companyId);
  if (!company) {
    const error = new Error('Company not found');
    error.status = 404;
    throw error;
  }

  const roleCompatibility = {
    brokerage: ['broker_owner', 'broker_admin', 'broker', 'operations_manager',
                'compliance_officer', 'finance', 'viewer'],
    carrier: ['carrier_owner', 'carrier_admin', 'dispatcher', 'driver', 'viewer'],
    platform: ['platform_admin', 'platform_support', 'viewer']
  };

  const compatibleRoles = roleCompatibility[company.type];
  if (!compatibleRoles || !compatibleRoles.includes(role)) {
    const error = new Error(`Role '${role}' is not compatible with ${company.type} company type`);
    error.status = 400;
    throw error;
  }

  const existing = await Membership.findOne({ user: userId, company: companyId });
  if (existing) {
    const error = new Error('User already has a membership in this company');
    error.status = 409;
    throw error;
  }

  const membership = await Membership.create({
    user: userId,
    company: companyId,
    role,
    isActive: true
  });

  return membership;
}

async function getMembership(userId, companyId) {
  return Membership.findOne({ user: userId, company: companyId });
}

async function listUserMemberships(userId) {
  return Membership.find({ user: userId, isActive: true })
    .populate('company', 'name slug type status');
}

async function toggleMembershipStatus(membershipId, active) {
  return Membership.findByIdAndUpdate(membershipId, { isActive: Boolean(active) }, { new: true });
}

async function hasMembershipRole(userId, companyId, role) {
  const membership = await Membership.findOne({ user: userId, company: companyId, isActive: true });
  if (!membership) return false;
  return (membership.permissions || []).includes(role) || membership.role === role;
}

module.exports = {
  createCompany,
  createMembership,
  getMembership,
  listUserMemberships,
  toggleMembershipStatus,
  hasMembershipRole
};
