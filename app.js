const express = require('express');
const morgan = require('morgan');
const healthRoutes = require('./routes/healthRoutes');
const carrierRoutes = require('./routes/carrierRoutes');
const documentRoutes = require('./routes/documentRoutes');
const companyRoutes = require('./routes/companyRoutes');
const loadRoutes = require('./routes/loadRoutes');
const vettingRoutes = require('./routes/vettingRoutes');
const authRoutes = require('./routes/authRoutes');
const crmRoutes = require('./routes/crmRoutes');
const tmsRoutes = require('./routes/tmsRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const payableRoutes = require('./routes/payableRoutes');
const expenseRoutes = require('./routes/expenseRoutes');
const creditNoteRoutes = require('./routes/creditNoteRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const notificationDeliveryRoutes = require('./routes/notificationDeliveryRoutes');
const notificationPreferenceRoutes = require('./routes/notificationPreferenceRoutes');
const financeExportRoutes = require('./routes/financeExportRoutes');
const documentExpiryRoutes = require('./routes/documentExpiryRoutes');
const jobRoutes = require('./routes/jobRoutes');
const externalAdapterRoutes = require('./routes/externalAdapterRoutes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const { securityHeaders } = require('./middleware/securityHeaders');
const { rateLimiter } = require('./middleware/rateLimiter');

const app = express();

// Global security headers (applied to every response).
app.use(securityHeaders);

// Global rate limiter: 120 requests per minute per IP + route.
app.use(rateLimiter({ windowMs: 60 * 1000, max: 120 }));

// Stricter rate limit on auth endpoints.
app.use('/api/auth', rateLimiter({ windowMs: 60 * 1000, max: 20 }));

// Express body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// HTTP request logging (development: colored console output)
app.use(morgan('dev'));

// CORS headers for cross-origin frontend communication (Vercel ↔ Render)
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Mount Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/carriers', carrierRoutes);
app.use('/api/carriers', documentRoutes);
app.use('/api/loads', loadRoutes);
app.use('/api/vetting', vettingRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/tms', tmsRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/payables', payableRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/credit-notes', creditNoteRoutes);
app.use('/api/notifications/delivery', notificationDeliveryRoutes);
app.use('/api/notifications/preferences', notificationPreferenceRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/financial/export', financeExportRoutes);
app.use('/api/document-expiry', documentExpiryRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/adapters', externalAdapterRoutes);

// Catch 404 & forward to error handler
app.use(notFound);

// Centralized JSON error handler
app.use(errorHandler);

/**
 * Database-backed startup initialisation:
 *  1. ensure the unique "one approval per load" index really exists
 *     (repairing legacy duplicate approvals first), and
 *  2. reconcile loads left ASSIGNED without an active audit snapshot
 *     (crash between the load claim and the snapshot write).
 *
 * Called from server.js on boot and from the test harness setup.
 */
const initializeDatabaseState = async (options = {}) => {
  const { ensureAssignmentIndexes } = require('./services/assignmentIndexInitializer');
  const { reconcileOrphanedAssignments } = require('./services/assignmentRecovery');
  const { reconcileCarrierTenancy } = require('./services/carrierMigration');

  const indexResult = await ensureAssignmentIndexes(options);
  const recoveryResult = await reconcileOrphanedAssignments(options);
  const carrierMigrationResult = await reconcileCarrierTenancy(options);
  return { indexResult, recoveryResult, carrierMigrationResult };
};

module.exports = app;
module.exports.initializeDatabaseState = initializeDatabaseState;
