const mongoose = require('mongoose');
const Membership = require('../models/Membership');

/**
 * Middleware: requireCompanyContext
 *
 * Strict verified company-membership resolution.
 * - Resolves the selected company from X-Company-Id or authenticated user context.
 * - In demo mode (x-demo-mode: true or query demo=true):
 *   Allows demo-only carrier access.
 * - When company context is provided:
 *   Verifies that the authenticated user has an active membership in that exact company.
 *   Rejects invalid, missing, or inactive membership with HTTP 403.
 * - If neither company context nor demo mode is specified:
 *   Rejects with HTTP 403 (missing company context).
 */
const requireCompanyContext = async (req, res, next) => {
  try {
    const rawCompanyId = req.headers['x-company-id'] || (req.user && req.user.companyId);
    const isExplicitDemo = req.headers['x-demo-mode'] === 'true' || req.query.demo === 'true';

    if (rawCompanyId) {
      if (!mongoose.Types.ObjectId.isValid(String(rawCompanyId))) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: Invalid active company context',
          code: 'INVALID_COMPANY_CONTEXT'
        });
      }

      if (!req.user || !req.user.id) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required to access company resources',
          code: 'AUTH_REQUIRED'
        });
      }

      const companyObjectId = new mongoose.Types.ObjectId(String(rawCompanyId));

      // Verify active membership in the exact company specified
      const membership = await Membership.findOne({
        user: req.user.id,
        company: companyObjectId,
        isActive: true
      }).populate('company', 'name slug type status');

      if (!membership) {
        const inactiveMembership = await Membership.findOne({
          user: req.user.id,
          company: companyObjectId,
          isActive: false
        });

        if (inactiveMembership) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden: Membership in this company is inactive or suspended',
            code: 'MEMBERSHIP_INACTIVE'
          });
        }

        return res.status(403).json({
          success: false,
          error: 'Forbidden: You do not have an active membership in this company',
          code: 'NOT_A_MEMBER'
        });
      }

      req.companyId = companyObjectId;
      req.company = membership.company;
      req.membership = membership;
      req.isDemoMode = false;
      return next();
    }

    if (isExplicitDemo) {
      req.isDemoMode = true;
      return next();
    }

    // If unauthenticated and not explicit demo mode: reject with 401
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required: missing Bearer token',
        code: 'AUTH_REQUIRED'
      });
    }

    // Authenticated user with missing company context: reject with 403
    return res.status(403).json({
      success: false,
      error: 'Forbidden: Missing active company context. Provide X-Company-Id header or active company selection.',
      code: 'COMPANY_CONTEXT_REQUIRED'
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  requireCompanyContext
};
