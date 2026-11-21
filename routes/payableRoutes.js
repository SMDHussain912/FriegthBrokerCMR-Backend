const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const payable = require('../services/payableService');
const { PayableError } = require('../services/payableService');

function handle(err, res, next) {
  if (err instanceof PayableError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return next(err);
}

// List payables
router.get('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await payable.listPayables(req, req.query)); } catch (e) { handle(e, res, next); }
});

// Create payable
router.post('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await payable.createPayable(req, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Get payable
router.get('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await payable.getPayable(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Update payable
router.patch('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await payable.updatePayable(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Void payable
router.patch('/:id/void', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await payable.voidPayable(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Record carrier payment
router.post('/:id/payment', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await payable.recordCarrierPayment(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

module.exports = router;
