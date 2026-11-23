const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const { requirePermissions } = require('../services/rbac');
const Tender = require('../models/Tender');
const Load = require('../models/Load');
const Carrier = require('../models/Carrier');
const NumberSequence = require('../models/NumberSequence');
const { recordAuditEvent } = require('../services/auditService');
const { sendTender, getTender, listTenders, viewTender, acceptTender, rejectTender, counterTender, withdrawTender, acceptCounter, expireOldTenders, getTenderStats } = require('../services/tenderService');

/**
 * @route   POST /api/tenders
 * @desc    Send tender to carrier
 * @access  Authenticated (broker)
 */
router.post('/', requireAuth, requireCompanyContext, requirePermissions('CREATE_LOAD', 'MANAGE_LOAD_TENDERS'), async (req, res, next) => {
  try {
    const { loadId, carrierId, offeredRate, offeredRatePerMile, expiresInHours = 24, idempotencyKey } = req.body || {};

    if (!loadId || !carrierId || !offeredRate) {
      return res.status(400).json({
        success: false,
        error: 'loadId, carrierId, and offeredRate are required',
        code: 'REQUIRED_FIELDS'
      });
    }

    const result = await sendTender({
      loadId,
      carrierId,
      offeredRate,
      offeredRatePerMile,
      expiresInHours,
      idempotencyKey,
      companyId: req.companyId,
      sentBy: req.user.id,
      isDemoData: req.isDemoMode
    });

    return res.status(201).json({ success: true, tender: result });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   GET /api/tenders
 * @desc    List tenders with filters
 * @access  Authenticated
 */
router.get('/', requireAuth, requireCompanyContext, requirePermissions('VIEW_LOADS'), async (req, res, next) => {
  try {
    const { status, carrierId, loadId, limit = 50, skip = 0, sort = '-sentAt' } = req.query;

    const result = await listTenders({
      companyId: req.companyId,
      status,
      carrierId,
      loadId,
      limit: parseInt(limit),
      skip: parseInt(skip),
      sort
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   GET /api/tenders/stats
 * @desc    Get tender statistics
 * @access  Authenticated
 */
router.get('/stats', requireAuth, requireCompanyContext, requirePermissions('VIEW_LOADS'), async (req, res, next) => {
  try {
    const stats = await getTenderStats(req.companyId);
    return res.json({ success: true, stats });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   GET /api/tenders/:tenderId
 * @desc    Get tender by ID
 * @access  Authenticated
 */
router.get('/:tenderId', requireAuth, requireCompanyContext, requirePermissions('VIEW_LOADS'), async (req, res, next) => {
  try {
    const tender = await getTender({ tenderId: req.params.tenderId, companyId: req.companyId });
    return res.json({ success: true, tender });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/tenders/:tenderId/view
 * @desc    Carrier views tender
 * @access  Authenticated
 */
router.post('/:tenderId/view', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const tender = await viewTender({ tenderId: req.params.tenderId, companyId: req.companyId, userId: req.user.id });
    return res.json({ success: true, tender });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/tenders/:tenderId/accept
 * @desc    Carrier accepts tender
 * @access  Authenticated
 */
router.post('/:tenderId/accept', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const { notes = '' } = req.body || {};
    const result = await acceptTender({ tenderId: req.params.tenderId, companyId: req.companyId, userId: req.user.id, notes });
    return res.json({ success: true, ...result });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/tenders/:tenderId/reject
 * @desc    Carrier rejects tender
 * @access  Authenticated
 */
router.post('/:tenderId/reject', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const { reason = '' } = req.body || {};
    const tender = await rejectTender({ tenderId: req.params.tenderId, companyId: req.companyId, userId: req.user.id, reason });
    return res.json({ success: true, tender });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/tenders/:tenderId/counter
 * @desc    Carrier counters tender
 * @access  Authenticated
 */
router.post('/:tenderId/counter', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const { rate, reason = '' } = req.body || {};
    if (!rate) {
      return res.status(400).json({ success: false, error: 'Counter rate is required', code: 'RATE_REQUIRED' });
    }
    const tender = await counterTender({ tenderId: req.params.tenderId, companyId: req.companyId, userId: req.user.id, rate, reason });
    return res.json({ success: true, tender });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/tenders/:tenderId/withdraw
 * @desc    Broker withdraws tender
 * @access  Authenticated (broker)
 */
router.post('/:tenderId/withdraw', requireAuth, requireCompanyContext, requirePermissions('MANAGE_LOAD_TENDERS'), async (req, res, next) => {
  try {
    const tender = await withdrawTender({ tenderId: req.params.tenderId, companyId: req.companyId, userId: req.user.id });
    return res.json({ success: true, tender });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/tenders/:tenderId/accept-counter
 * @desc    Broker accepts carrier counter-offer
 * @access  Authenticated (broker)
 */
router.post('/:tenderId/accept-counter', requireAuth, requireCompanyContext, requirePermissions('MANAGE_LOAD_TENDERS'), async (req, res, next) => {
  try {
    const result = await acceptCounter({ tenderId: req.params.tenderId, companyId: req.companyId, userId: req.user.id });
    return res.json({ success: true, ...result });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/tenders/expire
 * @desc    Expire old tenders (scheduled job)
 * @access  Authenticated (system)
 */
router.post('/expire', requireAuth, async (req, res, next) => {
  try {
    const count = await expireOldTenders();
    return res.json({ success: true, expiredCount: count });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
