const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const job = require('../services/jobService');
const { JobError } = require('../services/jobService');

function handle(err, res, next) {
  if (err instanceof JobError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return next(err);
}

// List jobs
router.get('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await job.listJobs(req, req.query)); } catch (e) { handle(e, res, next); }
});

// Enqueue job
router.post('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await job.enqueueJob(req, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Get job
router.get('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await job.getJob(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Retry job
router.post('/:id/retry', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await job.retryJob(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Cancel job
router.delete('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await job.cancelJob(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Process due jobs
router.post('/process-due', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await job.processDueJobs(req)); } catch (e) { handle(e, res, next); }
});

module.exports = router;
