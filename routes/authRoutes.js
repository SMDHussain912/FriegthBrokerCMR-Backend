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

/**
 * @route   POST /api/auth/register
 * @desc    Register a new user account (name, email, password, role).
 * @access  Public
 */
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        error: 'Name is required',
        code: 'NAME_REQUIRED'
      });
    }
    const emailValue = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!emailValue) {
      return res.status(400).json({
        success: false,
        error: 'Email is required',
        code: 'EMAIL_REQUIRED'
      });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters',
        code: 'PASSWORD_TOO_SHORT'
      });
    }
    // SECURITY: public registration ALWAYS creates a plain `broker` account.
    // Privileged roles (compliance_officer, admin) are assigned only by an
    // authenticated, authorized administrative process. The client-supplied
    // `role` (if any) is IGNORED so a caller can never self-escalate.
    const existing = await User.findOne({ email: emailValue });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'An account with this email already exists',
        code: 'EMAIL_EXISTS'
      });
    }

    // Statics are exposed directly on the model (e.g. `User.hashPassword`).
    // `User.statics` is not part of the public Mongoose model API.
    const passwordHash = await User.hashPassword(password);
    const user = await User.create({
      name: String(name).trim(),
      email: emailValue,
      passwordHash,
      role: 'broker',
      isDemoData: false
    });

    const token = signToken(user);
    return res.status(201).json({
      success: true,
      token,
      user: user.toSafeJSON(),
      message: 'Account created. You are now signed in.'
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;