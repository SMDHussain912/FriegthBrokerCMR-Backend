const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { signToken, requireAuth } = require('../middleware/auth');
const crypto = require('crypto');

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

/**
 * @route   POST /api/auth/password/change
 * @desc    Authenticated user changes their own password (requires current password)
 * @access  Authenticated
 */
router.post('/password/change', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Current password and new password are required',
        code: 'PASSWORDS_REQUIRED'
      });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'New password must be at least 8 characters',
        code: 'PASSWORD_TOO_SHORT'
      });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({
        success: false,
        error: 'New password must differ from current password',
        code: 'PASSWORD_UNCHANGED'
      });
    }

    const user = await User.findById(req.user.id).select('+passwordHash');
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const ok = await user.verifyPassword(currentPassword);
    if (!ok) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }

    user.passwordHash = await User.hashPassword(newPassword);
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/password/reset/request
 * @desc    Request a password reset token for an email (always returns 200 to
 *          avoid user enumeration). Token is hashed before storage and expires
 *          after 1 hour.
 * @access  Public
 */
router.post('/password/reset/request', async (req, res, next) => {
  try {
    const emailValue = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!emailValue) {
      return res.status(400).json({
        success: false,
        error: 'Email is required',
        code: 'EMAIL_REQUIRED'
      });
    }
    const user = await User.findOne({ email: emailValue });
    if (!user) {
      // Never reveal whether an email exists.
      return res.json({ success: true, message: 'If an account exists, a reset token has been issued.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = crypto.createHash('sha256').update(token).digest('hex');
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();
    // In production this token would be sent via email. Here we return it so
    // the local dev flow can be exercised end-to-end.
    return res.json({
      success: true,
      message: 'Reset token issued.',
      resetToken: token
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/password/reset/confirm
 * @desc    Confirm a password reset using a valid, unexpired token
 * @access  Public
 */
router.post('/password/reset/confirm', async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Reset token and new password are required',
        code: 'RESET_REQUIRED'
      });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'New password must be at least 8 characters',
        code: 'PASSWORD_TOO_SHORT'
      });
    }

    const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      passwordResetToken: resetTokenHash,
      passwordResetExpires: { $gt: new Date() }
    }).select('+passwordHash');
    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired reset token',
        code: 'INVALID_RESET_TOKEN'
      });
    }

    user.passwordHash = await User.hashPassword(newPassword);
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
    return res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;