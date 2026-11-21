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

// List notifications
router.get('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await notification.listNotifications(req, req.query)); } catch (e) { handle(e, res, next); }
});

// Create notification
router.post('/', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.status(201).json(await notification.createNotification(req, req.body || {})); } catch (e) { handle(e, res, next); }
});

// Get notification
router.get('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await notification.getNotification(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Mark notification read
router.patch('/:id/read', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await notification.markNotificationRead(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

// Mark all notifications read
router.post('/read-all', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await notification.markAllNotificationsRead(req)); } catch (e) { handle(e, res, next); }
});

// Delete notification
router.delete('/:id', requireAuth, requireCompanyContext, async (req, res, next) => {
  try { res.json(await notification.deleteNotification(req, req.params.id)); } catch (e) { handle(e, res, next); }
});

module.exports = router;
