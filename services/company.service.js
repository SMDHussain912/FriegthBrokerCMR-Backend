const Company = require('../models/Company');

/**
 * Company creation service.
 * Validates input, creates company, and enrolls the creator as owner.
 */
export async function createCompany(creatorId, companyData) {
  if (!companyData.name) {
    const error = new Error('Company name is required');
    error.status = 400;
    throw error;
  }

  const existing = await Company.findOne({ slug: companyData.slug.trim().toLowerCase() });
  if (existing) {
    const error = new Error('A company with this slug already exists');
    error.status = 409;
    throw error;
  }

  const companyDataTrimmed = {
    name: companyData.name.trim(),
    slug: companyData.slug.trim().toLowerCase(),
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
    role: 'broker_owner',
    isActive: true
  });

  return company;
}

/**
 * Membership creation service.
 * Validates role compatibility with company type.
 */
export async function createMembership(userId, companyId, role) {
  const company = await Company.findById(companyId);
  if (!company) {
    const error = new Error('Company not found');
    error.status = 404;
    throw error;
  }

  const roleCompatibility = {
    brokerage: ['broker_owner', 'broker_admin', 'broker', 'operations_manager',
                'compliance_officer', 'finance', 'viewer'],
    carrier: ['carrier_owner', 'carrier_admin', 'dispatcher', 'driver'],
    platform: ['platform_admin', 'platform_support']
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
    role: role,
    isActive: true
  });

  return membership;
}

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
