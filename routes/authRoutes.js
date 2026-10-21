const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { signToken } = require('../middleware/auth');

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate with email + password, return JWT (bcrypt-verified)
 * @access  Public
 */
router.post('/login', async (req, res, next) => {
  try {
    const email = req.body.email ? String(req.body.email).trim().toLowerCase() : '';
    const password = req.body.password ? String(req.body.password) : '';
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
        code: 'CREDENTIALS_REQUIRED'
      });
    }
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    // Demo accounts must never be usable in production, even with valid
    // credentials — they are published in the README/seed output.
    if (user.isDemoData && String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
      return res.status(403).json({
        success: false,
        error: 'Demo accounts are disabled in this environment',
        code: 'DEMO_ACCOUNT_DISABLED'
      });
    }
    const ok = await user.verifyPassword(password);
    if (!ok) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
    const token = signToken(user);
    return res.json({ success: true, token, user: user.toSafeJSON() });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   GET /api/auth/me
 * @desc    Current authenticated user (roles from server, never client)
 * @access  Authenticated
 */
const { requireAuth } = require('../middleware/auth');

router.get('/me', requireAuth, async (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;
