const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const expense = require('../services/expenseService');
const { ExpenseError } = require('../services/expenseService');

function handle(err, res, next) {
  if (err instanceof ExpenseError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return next(err);
}

// List expenses
router.get('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await expense.listExpenses(req, req.query)); } catch (e) { handle(e, res, next); }
});

// Create expense
router.post('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await expense.createExpense(req, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Get expense
router.get('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await expense.getExpense(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Update expense
router.patch('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await expense.updateExpense(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Void expense
router.patch('/:id/void', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await expense.voidExpense(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Record expense payment
router.post('/:id/payment', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await expense.recordExpensePayment(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

module.exports = router;
