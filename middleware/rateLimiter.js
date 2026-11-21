/**
 * In-memory rate limiter middleware.
 *
 * Tracks request counts per (IP + route path) within a sliding window.
 * When the limit is exceeded, responds with HTTP 429 and a Retry-After
 * header. Intended for single-instance deployments; for multi-instance
 * deployments this should be backed by Redis.
 *
 * Not security-critical on its own — it is a blunt abuse/misuse guard,
 * not a replacement for authentication or authorization.
 */
const rateLimiter = (options = {}) => {
  const windowMs = options.windowMs || 60 * 1000; // 1 minute
  const max = options.max || 100; // 100 requests per window
  const keyGenerator = options.keyGenerator || ((req) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return `${ip}:${req.originalUrl}`;
  });

  const windows = new Map();

  const cleanup = () => {
    const now = Date.now();
    for (const [key, { expiresAt }] of windows.entries()) {
      if (now >= expiresAt) windows.delete(key);
    }
  };
  setInterval(cleanup, windowMs);

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    let entry = windows.get(key);
    if (!entry || now >= entry.expiresAt) {
      entry = { count: 0, expiresAt: now + windowMs };
      windows.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(entry.expiresAt / 1000)));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.expiresAt - now) / 1000)));
      return res.status(429).json({
        success: false,
        error: 'Too many requests, please try again later.',
        code: 'RATE_LIMITED'
      });
    }
    next();
  };
};

module.exports = { rateLimiter };
