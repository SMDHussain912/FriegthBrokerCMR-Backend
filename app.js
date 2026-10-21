const express = require('express');
const healthRoutes = require('./routes/healthRoutes');
const carrierRoutes = require('./routes/carrierRoutes');
const loadRoutes = require('./routes/loadRoutes');
const authRoutes = require('./routes/authRoutes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Express body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Standard CORS headers for frontend communication
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
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
app.use('/api/carriers', carrierRoutes);
app.use('/api/loads', loadRoutes);

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

  const indexResult = await ensureAssignmentIndexes(options);
  const recoveryResult = await reconcileOrphanedAssignments(options);
  return { indexResult, recoveryResult };
};

module.exports = app;
module.exports.initializeDatabaseState = initializeDatabaseState;
