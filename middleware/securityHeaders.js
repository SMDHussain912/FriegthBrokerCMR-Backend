/**
 * Security headers middleware.
 * Applies a restrictive default set of HTTP response headers to reduce the
 * attack surface: clickjacking, MIME sniffing, XSS, and referrer leakage.
 * All headers are overridable per-route if a specific endpoint needs a
 * relaxed policy (e.g. file downloads).
 */
const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self';"
  );
  next();
};

module.exports = { securityHeaders };
