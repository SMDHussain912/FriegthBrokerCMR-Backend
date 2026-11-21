const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const notificationDelivery = require('../services/notificationDeliveryService');
const { NotificationDeliveryError } = require('../services/notificationDeliveryService');

function handle(err, res, next) {
  if (err instanceof NotificationDeliveryError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return next(err);
}

/**
 * @route   GET /api/notifications/delivery
 * @desc    List notification delivery history for the authenticated user
 * @access  Authenticated (requires company context)
 */
router.get('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await notificationDelivery.listDeliveryHistory(req, req.query)); } catch (e) { handle(e, res, next); }
});

/**
 * @route   POST /api/notifications/delivery
 * @desc    Send a notification via one or more delivery channels (email/sms/push)
 * @access  Authenticated (requires write role, company context)
 */
router.post('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await notificationDelivery.sendNotification(req, req.body || {})); } catch (e) { handle(e, res, next); }
});

/**
 * @route   GET /api/notifications/delivery/:id
 * @desc    Get a single delivery record
 * @access  Authenticated (requires company context)
 */
router.get('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await notificationDelivery.getDeliveryHistory(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

module.exports = router;
