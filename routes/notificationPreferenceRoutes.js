const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const notification = require('../services/notificationService');
const { NotificationError } = require('../services/notificationService');

function handle(err, res, next) {
  if (err instanceof NotificationError) return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  return next(err);
}

// Get notification preferences
router.get('/preferences', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await notification.getPreferences(req)); } catch (e) { handle(e, res, next); }
});

// Update notification preferences
router.patch('/preferences', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await notification.updatePreferences(req, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Cleanup old notifications
router.post('/cleanup', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await notification.cleanupOldNotifications(req, req.body || {})); } catch (e) { handle(e, res, next); }
});

module.exports = router;
