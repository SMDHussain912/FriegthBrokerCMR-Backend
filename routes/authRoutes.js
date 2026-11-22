const express = require('express');
const router = express.Router();
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { requireCompanyContext } = require('../middleware/companyContext');
const { csrfProtectionMiddleware } = require('../middleware/csrf');
const authService = require('../services/authService');
const User = require('../models/User');
const Session = require('../models/Session');
const { recordAuditEvent } = require('../services/auditService');

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate with email + password, create session, return tokens
 * @access  Public
 */
router.post('/login', async (req, res, next) => {
  try {
    const email = req.body.email ? String(req.body.email).trim().toLowerCase() : '';
    const password = req.body.password ? String(req.body.password) : '';
    const companyId = req.body.companyId ? String(req.body.companyId) : null;
    const deviceId = req.body.deviceId ? String(req.body.deviceId) : null;
    const rememberMe = req.body.rememberMe === true;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
        code: 'CREDENTIALS_REQUIRED'
      });
    }

    const result = await authService.authenticate({
      email,
      password,
      companyId,
      deviceId,
      userAgent: req.headers['user-agent'],
      ipAddress: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress,
      rememberMe,
      req
    });

    if (!result.success) {
      const status = result.code === 'ACCOUNT_INACTIVE' || result.code === 'NO_COMPANY_ACCESS' ? 403 : 401;
      return res.status(status).json({
        success: false,
        error: result.message,
        code: result.code,
        requiresMfa: result.requiresMfa,
        sessionId: result.sessionId
      });
    }

    // Set refresh token as httpOnly cookie (secure in production)
    if (result.refreshToken) {
      const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'none' : 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });
    }

    return res.json({
      success: true,
      accessToken: result.accessToken,
      user: result.user,
      requiresMfa: result.requiresMfa || false,
      sessionId: result.sessionId
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/mfa/verify
 * @desc    Verify MFA code and complete login
 * @access  Public (requires sessionId from login)
 */
router.post('/mfa/verify', async (req, res, next) => {
  try {
    const { sessionId, code, method = 'totp' } = req.body || {};

    if (!sessionId || !code) {
      return res.status(400).json({
        success: false,
        error: 'Session ID and MFA code are required',
        code: 'MFA_REQUIRED'
      });
    }

    const result = await authService.verifyMfa({
      sessionId,
      code,
      method
    });

    if (!result.success) {
      return res.status(401).json({
        success: false,
        error: result.message,
        code: result.code
      });
    }

    // Set new refresh token cookie if rotated
    if (result.refreshToken) {
      const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'none' : 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000
      });
    }

    return res.json({
      success: true,
      accessToken: result.accessToken,
      user: result.user
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token using refresh token (cookie or body)
 * @access  Public
 */
router.post('/refresh', async (req, res, next) => {
  try {
    // Get refresh token from cookie or body
    const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;
    const deviceId = req.body.deviceId;

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        error: 'Refresh token required',
        code: 'REFRESH_TOKEN_REQUIRED'
      });
    }

    const result = await authService.refreshAccessToken({
      refreshToken,
      deviceId,
      userAgent: req.headers['user-agent'],
      ipAddress: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress
    });

    if (!result.success) {
      // Clear invalid cookie
      res.clearCookie('refreshToken');
      return res.status(401).json({
        success: false,
        error: result.message,
        code: result.code
      });
    }

    // Set new rotated refresh token cookie
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    return res.json({
      success: true,
      accessToken: result.accessToken,
      user: result.user
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/logout
 * @desc    Logout and revoke session
 * @access  Authenticated
 */
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const { allSessions = false } = req.body || {};
    const sessionId = req.user.sessionId || req.headers['x-session-id'];
    const refreshToken = req.cookies?.refreshToken;

    const result = await authService.logout({
      sessionId,
      refreshToken,
      userId: req.user.id,
      allSessions
    });

    // Clear refresh token cookie
    res.clearCookie('refreshToken');

    return res.json(result);
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
 * @route   GET /api/auth/sessions
 * @desc    Get active sessions for current user
 * @access  Authenticated
 */
router.get('/sessions', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const sessions = await authService.getActiveSessions(req.user.id, req.companyId);
    return res.json({ success: true, sessions });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   DELETE /api/auth/sessions/:sessionId
 * @desc    Revoke a specific session
 * @access  Authenticated
 */
router.delete('/sessions/:sessionId', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const result = await authService.revokeSession({
      sessionId,
      userId: req.user.id,
      revokedBy: req.user.id,
      reason: 'user_revoke'
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/sessions/:sessionId/trust
 * @desc    Mark a device as trusted
 * @access  Authenticated
 */
router.post('/sessions/:sessionId/trust', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const result = await authService.trustDevice({ sessionId, userId: req.user.id });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   DELETE /api/auth/sessions/:sessionId/trust
 * @desc    Remove trusted status from device
 * @access  Authenticated
 */
router.delete('/sessions/:sessionId/trust', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const result = await authService.untrustDevice({ sessionId });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   GET /api/auth/login-history
 * @desc    Get login history for current user
 * @access  Authenticated
 */
router.get('/login-history', requireAuth, requireCompanyContext, async (req, res, next) => {
  try {
    const { limit = 50 } = req.query;
    const history = await authService.getLoginHistory({
      userId: req.user.id,
      companyId: req.companyId,
      limit: parseInt(limit)
    });
    return res.json({ success: true, history });
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/mfa/setup
 * @desc    Initiate MFA setup (returns secret and QR code)
 * @access  Authenticated
 */
router.post('/mfa/setup', requireAuth, async (req, res, next) => {
  try {
    const result = await authService.setupMfa({ userId: req.user.id });
    if (!result.success) {
      return res.status(400).json(result);
    }
    // Don't return secret in response after setup confirmed
    // For now return it for QR code generation
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/mfa/confirm
 * @desc    Confirm MFA setup with TOTP code
 * @access  Authenticated
 */
router.post('/mfa/confirm', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ success: false, error: 'MFA code required', code: 'CODE_REQUIRED' });
    }
    const result = await authService.confirmMfaSetup({ userId: req.user.id, code });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/mfa/disable
 * @desc    Disable MFA (requires password)
 * @access  Authenticated
 */
router.post('/mfa/disable', requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ success: false, error: 'Password required', code: 'PASSWORD_REQUIRED' });
    }
    const result = await authService.disableMfa({ userId: req.user.id, password });
    if (!result.success) {
      return res.status(400).json(result);
    }
    // Clear refresh token cookie since all sessions revoked
    res.clearCookie('refreshToken');
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/mfa/backup-codes
 * @desc    Regenerate MFA backup codes (requires password)
 * @access  Authenticated
 */
router.post('/mfa/backup-codes', requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ success: false, error: 'Password required', code: 'PASSWORD_REQUIRED' });
    }
    const result = await authService.regenerateBackupCodes({ userId: req.user.id, password });
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/password/change
 * @desc    Change password (requires current password)
 * @access  Authenticated
 */
router.post('/password/change', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Current and new password required', code: 'PASSWORDS_REQUIRED' });
    }
    const result = await authService.changePassword({ userId: req.user.id, currentPassword, newPassword });
    if (!result.success) {
      return res.status(400).json(result);
    }
    // Clear refresh token cookie since all sessions revoked
    res.clearCookie('refreshToken');
    return res.json(result);
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
    const result = await authService.requestPasswordReset({ email: emailValue });
    return res.json(result);
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
    const result = await authService.confirmPasswordReset({ token, newPassword });
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   POST /api/auth/passkeys
 * @desc    Add a passkey credential
 * @access  Authenticated
 */
router.post('/passkeys', requireAuth, async (req, res, next) => {
  try {
    const { credentialId, publicKey, counter, name } = req.body || {};
    if (!credentialId || !publicKey) {
      return res.status(400).json({ success: false, error: 'Credential ID and public key required', code: 'PASSKEY_REQUIRED' });
    }
    const result = await authService.addPasskey({ userId: req.user.id, credentialId, publicKey, counter, name });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

/**
 * @route   DELETE /api/auth/passkeys/:credentialId
 * @desc    Remove a passkey credential
 * @access  Authenticated
 */
router.delete('/passkeys/:credentialId', requireAuth, async (req, res, next) => {
  try {
    const { credentialId } = req.params;
    const result = await authService.removePasskey({ userId: req.user.id, credentialId });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
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

    const passwordHash = await User.hashPassword(password);
    const user = await User.create({ name: String(name).trim(), email: emailValue, passwordHash, role: 'broker' });
    const token = require('../middleware/auth').signToken(user);
    return res.status(201).json({ success: true, token, user: user.toSafeJSON() });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
