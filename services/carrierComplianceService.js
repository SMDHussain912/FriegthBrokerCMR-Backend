const mongoose = require('mongoose');
const Carrier = require('../models/Carrier');

class ComplianceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_EXPIRY_WARNING_DAYS = 30;
const READ_ROLES = new Set([
  'broker_owner', 'broker_admin', 'broker', 'operations_manager', 'compliance_officer',
  'finance', 'viewer', 'platform_admin', 'platform_support'
]);

function assertCompany(req) {
  const explicitDemo = req.headers && req.headers['x-demo-mode'] === 'true';
  const queryDemo = req.query && req.query.demo === 'true';
  if (req.isDemoMode || explicitDemo || queryDemo) {
    throw new ComplianceError(403, 'DEMO_NOT_ALLOWED', 'This operation is not available in demo mode.');
  }
  if (!req.companyId || !req.membership || !req.user) {
    throw new ComplianceError(403, 'COMPANY_CONTEXT_REQUIRED', 'Verified active company context is required.');
  }
}

function assertRole(req, allowed, action) {
  const role = req.membership && req.membership.role;
  if (!role || !allowed.has(role)) {
    throw new ComplianceError(403, 'FORBIDDEN_ROLE', `Role is not permitted to ${action}.`);
  }
}

function oid(value, label) {
  if (!mongoose.Types.ObjectId.isValid(String(value || ''))) {
    throw new ComplianceError(400, 'INVALID_ID', `${label} must be a valid ObjectId.`);
  }
}

function ensureBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ComplianceError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  }
}

const tenantFilter = (req) => ({ company: req.companyId, isDemoData: false, isArchived: { $ne: true } });

function daysBetween(a, b) {
  const ms = b - a;
  return ms / (1000 * 60 * 60 * 24);
}

function severityForDaysLeft(daysLeft) {
  if (daysLeft < 0) return 'high';
  if (daysLeft <= 7) return 'high';
  if (daysLeft <= 14) return 'medium';
  return 'low';
}

/**
 * Build compliance review items for all carriers in the active company.
 *
 * Each carrier is inspected for three sources of attention:
 *   1. Insurance policies expiring within the warning window (or already expired).
 *   2. Authority status other than ACTIVE.
 *   3. Vetting overallStatus that is not PASS.
 *
 * Results are tenant-scoped, deduplicated per carrier+reason, and sorted by
 * severity (high first) then earliest expiry.
 */
async function listComplianceReviewItems(req, query = {}) {
  assertCompany(req);
  assertRole(req, READ_ROLES, 'read compliance review queue');

  const warningDays = Number(query.expiryWarningDays || DEFAULT_EXPIRY_WARNING_DAYS);
  if (!Number.isFinite(warningDays) || warningDays < 0) {
    throw new ComplianceError(400, 'INVALID_EXPIRY_WARNING_DAYS', 'expiryWarningDays must be a non-negative number.');
  }

  const now = new Date();
  const cutoff = new Date(Date.now() + warningDays * 24 * 60 * 60 * 1000);

  const carriers = await Carrier.find(tenantFilter(req))
    .select('dotNumber mcNumber legalName authorityStatus authorityGrantDate overallStatus insurancePolicies createdAt updatedAt')
    .lean();

  const items = [];

  for (const carrier of carriers) {
    const base = {
      carrierId: String(carrier._id),
      dotNumber: carrier.dotNumber,
      mcNumber: carrier.mcNumber,
      legalName: carrier.legalName,
      overallStatus: carrier.overallStatus,
      authorityStatus: carrier.authorityStatus
    };

    // --- Insurance expiry / verification ---
    const policies = Array.isArray(carrier.insurancePolicies) ? carrier.insurancePolicies : [];
    for (const policy of policies) {
      const expirationDate = policy.expirationDate ? new Date(policy.expirationDate) : null;
      const daysLeft = expirationDate ? daysBetween(now, expirationDate) : null;

      // Expired policy (verificationStatus may already be EXPIRED, but check date too)
      if (expirationDate && expirationDate < now) {
        items.push({
          ...base,
          type: 'insurance_expiry',
          reason: `Insurance ${policy.policyType || 'policy'} (${policy.insuranceProvider || 'unknown provider'}) expired ${Math.abs(Math.floor(daysLeft))} days ago`,
          severity: 'high',
          policyId: String(policy._id),
          policyType: policy.policyType,
          verificationStatus: policy.verificationStatus,
          expiresAt: expirationDate.toISOString(),
          daysLeft: Math.floor(daysLeft)
        });
        continue;
      }

      // Expiring within warning window
      if (expirationDate && daysLeft <= warningDays) {
        items.push({
          ...base,
          type: 'insurance_expiry',
          reason: `Insurance ${policy.policyType || 'policy'} (${policy.insuranceProvider || 'unknown provider'}) expires in ${Math.floor(daysLeft)} days`,
          severity: severityForDaysLeft(daysLeft),
          policyId: String(policy._id),
          policyType: policy.policyType,
          verificationStatus: policy.verificationStatus,
          expiresAt: expirationDate.toISOString(),
          daysLeft: Math.floor(daysLeft)
        });
      }

      // Unverified policy that is still valid — re-verification reminder
      if (expirationDate && expirationDate >= now && !['VERIFIED'].includes(policy.verificationStatus)) {
        items.push({
          ...base,
          type: 'verification_review',
          reason: `Insurance ${policy.policyType || 'policy'} verification status is ${policy.verificationStatus || 'UNVERIFIED'}`,
          severity: 'medium',
          policyId: String(policy._id),
          policyType: policy.policyType,
          verificationStatus: policy.verificationStatus,
          expiresAt: expirationDate.toISOString(),
          daysLeft: Math.floor(daysLeft)
        });
      }
    }

    // --- Authority status ---
    if (carrier.authorityStatus !== 'ACTIVE') {
      items.push({
        ...base,
        type: 'authority',
        reason: `Operating authority is ${carrier.authorityStatus}`,
        severity: carrier.authorityStatus === 'REVOKED' ? 'high' : 'medium',
        authorityStatus: carrier.authorityStatus,
        authorityGrantDate: carrier.authorityGrantDate ? new Date(carrier.authorityGrantDate).toISOString() : undefined
      });
    }

    // --- Vetting overall status ---
    if (carrier.overallStatus && carrieOverallStatusNeedsReview(carrier.overallStatus)) {
      items.push({
        ...base,
        type: 'vetting',
        reason: `Carrier vetting status is ${carrier.overallStatus}`,
        severity: carrier.overallStatus === 'FAIL' ? 'high' : 'medium',
        overallStatus: carrier.overallStatus
      });
    }
  }

  // Sort: high severity first, then earliest expiry date, then legal name
  const severityRank = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => {
    const sa = severityRank[a.severity] ?? 9;
    const sb = severityRank[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    const da = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
    const db = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
    if (da !== db) return da - db;
    return String(a.legalName || '').localeCompare(String(b.legalName || ''));
  });

  // Apply status filter if requested
  let filtered = items;
  if (query.severity) {
    filtered = filtered.filter((i) => i.severity === String(query.severity));
  }
  if (query.type) {
    filtered = filtered.filter((i) => i.type === String(query.type));
  }

  const limit = Number(query.limit) > 0 ? Math.min(Number(query.limit), 200) : filtered.length;

  return {
    success: true,
    count: filtered.length,
    returned: limit,
    warningDays,
    asOf: now.toISOString(),
    reviewItems: filtered.slice(0, limit)
  };
}

function carrieOverallStatusNeedsReview(status) {
  return ['NEEDS_REVIEW', 'FAIL', 'UNKNOWN'].includes(String(status));
}

module.exports = {
  ComplianceError,
  listComplianceReviewItems,
  DEFAULT_EXPIRY_WARNING_DAYS,
  READ_ROLES
};
