const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const crm = require('../services/crmService');

function handle(err, res, next) {
  if (err instanceof crm.CrmError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return next(err);
}

// Customers
router.get('/customers', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.listCustomers(req, req.query)); } catch (e) { handle(e, res, next); }
});
router.post('/customers', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await crm.createCustomer(req, req.body || {})); } catch (e) { handle(e, res, next); }
});
router.get('/customers/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.getCustomer(req, req.params.id)); } catch (e) { handle(e, res, next); }
});
router.patch('/customers/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.updateCustomer(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Contacts & communication history
router.get('/contacts', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.listContacts(req, req.query)); } catch (e) { handle(e, res, next); }
});
router.post('/contacts', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await crm.createContact(req, req.body || {})); } catch (e) { handle(e, res, next); }
});
router.get('/contacts/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.getContact(req, req.params.id)); } catch (e) { handle(e, res, next); }
});
router.patch('/contacts/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.updateContact(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});
router.post('/contacts/:id/communications', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await crm.addCommunication(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

module.exports = router;

// Leads
router.get('/leads', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.listLeads(req, req.query)); } catch (e) { handle(e, res, next); }
});
router.post('/leads', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await crm.createLead(req, req.body || {})); } catch (e) { handle(e, res, next); }
});
router.get('/leads/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.getLead(req, req.params.id)); } catch (e) { handle(e, res, next); }
});
router.patch('/leads/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.updateLead(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});
router.post('/leads/:id/activities', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await crm.addLeadActivity(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Opportunities
router.get('/opportunities', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.listOpportunities(req, req.query)); } catch (e) { handle(e, res, next); }
});
router.post('/opportunities', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await crm.createOpportunity(req, req.body || {})); } catch (e) { handle(e, res, next); }
});
router.get('/opportunities/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.getOpportunity(req, req.params.id)); } catch (e) { handle(e, res, next); }
});
router.patch('/opportunities/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.updateOpportunity(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});
router.post('/opportunities/:id/activities', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await crm.addOpportunityActivity(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Quotes
router.get('/quotes', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.listQuotes(req, req.query)); } catch (e) { handle(e, res, next); }
});
router.post('/quotes', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await crm.createQuote(req, req.body || {})); } catch (e) { handle(e, res, next); }
});
router.get('/quotes/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.getQuote(req, req.params.id)); } catch (e) { handle(e, res, next); }
});
router.patch('/quotes/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.updateQuote(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Rate agreements / contracts
router.get('/rate-agreements', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.listRateAgreements(req, req.query)); } catch (e) { handle(e, res, next); }
});
router.post('/rate-agreements', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await crm.createRateAgreement(req, req.body || {})); } catch (e) { handle(e, res, next); }
});
router.get('/rate-agreements/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.getRateAgreement(req, req.params.id)); } catch (e) { handle(e, res, next); }
});
router.patch('/rate-agreements/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.updateRateAgreement(req, req.params.id, req.body || {})); } catch (e) { handle(e, res, next); }
});

router.delete('/customers/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.deleteCustomer(req, req.params.id)); } catch (e) { handle(e, res, next); }
});
router.delete('/contacts/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await crm.deleteContact(req, req.params.id)); } catch (e) { handle(e, res, next); }
});
