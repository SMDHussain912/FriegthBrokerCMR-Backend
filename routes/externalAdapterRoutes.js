const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const externalAdapter = require('../services/externalAdapterService');
const { ExternalAdapterError } = require('../services/externalAdapterService');

function handle(err, res, next) {
  if (err instanceof ExternalAdapterError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return next(err);
}

/**
 * @route   GET /api/adapters
 * @desc    List all external adapters and their configuration status
 * @access  Authenticated (requires company context)
 */
router.get('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await externalAdapter.listAdapters(req)); } catch (e) { handle(e, res, next); }
});

/**
 * @route   POST /api/adapters/:adapterType/execute
 * @desc    Execute an external adapter (FMCSA, insurance, GPS/ELD, maps, ETA, OCR, accounting, load_board, webhook)
 * @access  Authenticated (requires write role, company context)
 */
router.post('/:adapterType/execute', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await externalAdapter.executeAdapter(req, req.params.adapterType, req.body || {})); } catch (e) { handle(e, res, next); }
});

module.exports = router;
