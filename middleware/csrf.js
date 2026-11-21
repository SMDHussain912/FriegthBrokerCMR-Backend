/**
 * CSRF Protection Middleware
 * 
 * Implements double-submit cookie pattern for CSRF protection on
 * cookie-authenticated state-changing requests.
 * 
 * The frontend sets a CSRF token in a cookie (readable by JS) and
 * sends it in a custom header on state-changing requests.
 * The backend validates that the header matches the cookie.
 */

const crypto = require('crypto');

const CSRF_COOKIE_NAME = 'csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_COOKIE_MAX_AGE = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Generate a cryptographically secure CSRF token
 */
function generateCSRFToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Middleware to generate and set CSRF token cookie
 * Should be applied to all routes that serve HTML or initialize the SPA
 */
function csrfTokenMiddleware(req, res, next) {
  // Check if CSRF token cookie exists
  const existingToken = req.cookies?.[CSRF_COOKIE_NAME];
  
  if (!existingToken) {
    const token = generateCSRFToken();
    const isProduction = process.env.NODE_ENV === 'production';
    
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false, // Must be readable by JS for double-submit pattern
      secure: process.env.NODE_ENV === 'production',
      sameSite: isProduction ? 'strict' : 'lax',
      maxAge: CSRF_COOKIE_MAX_AGE,
      path: '/',
    });
  }
  
  next();
}

/**
 * Middleware to validate CSRF token on state-changing requests
 * Should be applied to all mutating endpoints (POST, PUT, PATCH, DELETE)
 * that use cookie-based authentication
 */
function csrfProtectionMiddleware(req, res, next) {
  // Only validate on state-changing methods
  const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (!mutatingMethods.includes(req.method)) {
    return next();
  }
  
  // Skip if request doesn't use cookie auth (e.g., Bearer token API calls)
  const hasBearerToken = req.headers.authorization?.startsWith('Bearer ');
  if (hasBearerToken) {
    return next();
  }
  
  // Skip health checks and public auth endpoints
  // Note: middleware is mounted at /api so req.path is relative to /api
  const publicPaths = ['/health', '/auth/login', '/auth/register', '/auth/password/reset', '/auth/password/change'];
  if (publicPaths.some(path => req.path.startsWith(path))) {
    return next();
  }
  
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME.toLowerCase()];
  
  if (!cookieToken || !headerToken) {
    return res.status(403).json({
      success: false,
      error: 'CSRF token required',
      code: 'CSRF_TOKEN_MISSING'
    });
  }
  
  if (!timingSafeEqual(cookieToken, headerToken)) {
    return res.status(403).json({
      success: false,
      error: 'Invalid CSRF token',
      code: 'CSRF_TOKEN_INVALID'
    });
  }
  
  next();
}

/**
 * Middleware to rotate CSRF token on sensitive actions
 * Call this after successful sensitive operations (login, password change, etc.)
 */
function rotateCSRFToken(req, res) {
  const newToken = generateCSRFToken();
  const isProduction = process.env.NODE_ENV === 'production';
  
  res.cookie(CSRF_COOKIE_NAME, newToken, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: isProduction ? 'strict' : 'lax',
    maxAge: CSRF_COOKIE_MAX_AGE,
    path: '/',
  });
  
  return newToken;
}

module.exports = {
  csrfTokenMiddleware,
  csrfProtectionMiddleware,
  rotateCSRFToken,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
};