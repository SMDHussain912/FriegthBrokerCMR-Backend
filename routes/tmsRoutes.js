const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const tms = require('../services/tmsService');

function handle(error, res, next) {
  if (error instanceof tms.TmsError) {
    return res.status(error.status).json({ success: false, error: error.message, code: error.code });
  }
  if (error && error.name === 'ValidationError') {
    return res.status(400).json({ success: false, error: error.message, code: 'VALIDATION_ERROR' });
  }
  if (error && error.code === 11000) {
    return res.status(409).json({ success: false, error: 'Duplicate record for this company.', code: 'DUPLICATE_RECORD' });
  }
  return next(error);
}

const wrap = (handler) => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    handle(error, res, next);
  }
};

// Stops, appointments and freight details
router.get('/loads/:loadId/stops', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.listStops(req, req.params.loadId));
}));

router.post('/loads/:loadId/stops', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.status(201).json(await tms.createStop(req, req.params.loadId, req.body || {}));
}));

router.patch('/stops/:stopId', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.updateStop(req, req.params.stopId, req.body || {}));
}));

router.post('/stops/:stopId/status', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.setStopStatus(req, req.params.stopId, req.body || {}));
}));

router.delete('/stops/:stopId', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.deleteStop(req, req.params.stopId));
}));

// Milestones, exceptions and activity history
router.get('/loads/:loadId/events', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.listEvents(req, req.params.loadId, req.query));
}));

router.post('/loads/:loadId/events', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.status(201).json(await tms.createEvent(req, req.params.loadId, req.body || {}));
}));

router.patch('/loads/:loadId/status', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.updateLoadStatus(req, req.params.loadId, req.body || {}));
}));

router.get('/activity', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.activityHistory(req, req.query));
}));

// Carrier matching and tendering
router.get('/loads/:loadId/tenders', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.listTenders(req, req.params.loadId));
}));

router.post('/loads/:loadId/tenders', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.status(201).json(await tms.createTender(req, req.params.loadId, req.body || {}));
}));

router.patch('/tenders/:tenderId', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.updateTenderStatus(req, req.params.tenderId, req.body || {}));
}));

// Load costs, customer rates and margins
router.get('/loads/:loadId/financials', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.getFinancials(req, req.params.loadId));
}));

router.put('/loads/:loadId/financials', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.updateFinancials(req, req.params.loadId, req.body || {}));
}));

// Operational exception queue (loads needing dispatch attention)
router.get('/exceptions', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.listExceptions(req, req.query));
}));

// Operational dashboard and reporting
router.get('/dashboard', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.dashboard(req));
}));

router.get('/reports/loads', requireAuth, requireCompanyContext, wrap(async (req, res) => {
  res.json(await tms.reportLoads(req, req.query));
}));

module.exports = router;