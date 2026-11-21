const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const invoice = require('../services/invoiceService');
const { InvoiceError } = require('../services/invoiceService');

function handle(err, res, next) {
  if (err instanceof InvoiceError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return next(err);
}

// List invoices
router.get('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await invoice.listInvoices(req, req.query)); } catch (e) { handle(e, res, next); }
});

// Create invoice
router.post('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await invoice.createInvoice(req, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Get invoice
router.get('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await invoice.getInvoice(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Update invoice
router.patch('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await invoice.updateInvoice(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Void invoice
router.patch('/:id/void', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await invoice.voidInvoice(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Record payment
router.post('/:id/payment', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await invoice.recordPayment(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

module.exports = router;
