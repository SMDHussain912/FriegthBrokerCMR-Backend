/**
 * 404 Route Not Found Middleware
 */
const notFound = (req, res, next) => {
  const error = new Error(`Route Not Found: [${req.method}] ${req.originalUrl}`);
  res.status(404);
  next(error);
};

module.exports = notFound;
