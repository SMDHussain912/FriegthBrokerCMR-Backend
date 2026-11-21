const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const financeExport = require('../services/financeExportService');
const { FinanceExportError } = require('../services/financeExportService');

function handle(err, res, next) {
  if (err instanceof FinanceExportError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return next(err);
}

/**
 * @route   GET /api/financial/export
 * @desc    Export financial records to CSV (invoices, payables, expenses, credit-notes)
 * @access  Authenticated read roles
 */
router.get('/export', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const entityType = req.query.entityType;
    if (!entityType) {
      return res.status(400).json({
        success: false,
        error: 'entityType is required',
        code: 'MISSING_ENTITY_TYPE'
      });
    }
    const result = await financeExport.exportFinancials(req, entityType, req.query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${entityType}-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.status(200).send(result.csv);
  } catch (e) {
    handle(e, res, next);
  }
});

module.exports = router;
