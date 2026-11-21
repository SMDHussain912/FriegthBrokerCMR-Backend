const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const creditNote = require('../services/creditNoteService');
const { CreditNoteError } = require('../services/creditNoteService');

function handle(err, res, next) {
  if (err instanceof CreditNoteError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return next(err);
}

// List credit notes
router.get('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await creditNote.listCreditNotes(req, req.query)); } catch (e) { handle(e, res, next); }
});

// Create credit note
router.post('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await creditNote.createCreditNote(req, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Get credit note
router.get('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await creditNote.getCreditNote(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Update credit note
router.patch('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await creditNote.updateCreditNote(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Void credit note
router.patch('/:id/void', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await creditNote.voidCreditNote(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Apply credit note
router.post('/:id/apply', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await creditNote.applyCreditNote(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

module.exports = router;
