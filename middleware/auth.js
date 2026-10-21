const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * JWT authentication middleware.
 * - Reads Bearer token from Authorization header.
 * - Verifies signature with JWT_SECRET (never trusts client roles).
 * - Loads the user from the trusted User collection.
 * - Attaches req.user = { id, email, name, role }.
 */

// The demo secret is intentionally committed for local development only.
// It must never be accepted in production, otherwise anyone could forge tokens.
const DEV_FALLBACK_SECRET = 'development_jwt_secret_freight_broker_crm_2026';

const isProduction = () => String(process.env.NODE_ENV || '').toLowerCase() === 'production';

/**
 * Resolve the JWT signing secret.
 * - In production: JWT_SECRET is REQUIRED and must not be the demo default;
 *   an insecure/missing secret is a fatal misconfiguration, not a fallback.
 * - In development/test: falls back to the documented demo secret.
 */
const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (isProduction()) {
    if (!secret || !secret.trim()) {
      throw new Error('FATAL: JWT_SECRET must be set in production');
    }
    if (secret === DEV_FALLBACK_SECRET) {
      throw new Error('FATAL: the demo JWT_SECRET must not be used in production');
    }
    if (secret.length < 32) {
      throw new Error('FATAL: JWT_SECRET must be at least 32 characters in production');
    }
  }
  return secret && secret.trim() ? secret : DEV_FALLBACK_SECRET;
};

const signToken = (user) => jwt.sign(
  { sub: String(user._id), email: user.email, role: user.role },
  getJwtSecret(),
  { expiresIn: '12h' }
);

const requireAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const parts = header.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required: missing Bearer token',
        code: 'AUTH_REQUIRED'
      });
    }
    let payload;
    let secret;
    try {
      // Resolve the secret BEFORE verifying: a production misconfiguration
      // must fail loudly (500) rather than masquerade as an invalid token.
      secret = getJwtSecret();
    } catch (secretError) {
      return next(secretError);
    }
    try {
      payload = jwt.verify(parts[1], secret);
    } catch (e) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token',
        code: 'INVALID_TOKEN'
      });
    }
    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Authenticated user no longer exists',
        code: 'USER_NOT_FOUND'
      });
    }
    req.user = {
      id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role
    };
    return next();
  } catch (error) {
    return next(error);
  }
};

// Role gate: only listed roles may proceed (roles from req.user, never body)
const requireRole = (...allowedRoles) => (req, res, next) => {
  const role = req.user && req.user.role;
  if (!role || allowedRoles.indexOf(role) === -1) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: requires role ' + allowedRoles.join(' or '),
      code: 'FORBIDDEN_ROLE'
    });
  }
  return next();
};

module.exports = { requireAuth, requireRole, signToken, getJwtSecret, DEV_FALLBACK_SECRET };
