const crypto = require('crypto');
const speakeasy = require('speakeasy');
const User = require('../models/User');
const Session = require('../models/Session');
const { signToken, getJwtSecret } = require('../middleware/auth');
const { recordAuditEvent } = require('./auditService');

/**
 * Auth Service - Centralized authentication and session management
 * Provides login, logout, session rotation, MFA, and security features
 */

// Token configuration
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 30;
const MFA_TOKEN_EXPIRY = '5m';

/**
 * Generate access token (short-lived)
 * @param {Object} user - User object
 * @param {Object} session - Session object
 * @returns {string} JWT access token
 */
function generateAccessToken(user, session) {
  return require('jsonwebtoken').sign(
    { 
      sub: String(user._id),
      email: user.email,
      role: user.role,
      sid: String(session._id), // Session ID
      mfa: session.mfaVerified
    },
    getJwtSecret(),
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

/**
 * Parse device info from user agent
 * @param {string} userAgent - User agent string
 * @returns {Object} Parsed device info
 */
function parseDeviceInfo(userAgent) {
  const ua = userAgent || '';
  let deviceType = 'unknown';
  let platform = 'unknown';
  let browser = 'unknown';

  if (/mobile|android|iphone|ipad/i.test(ua)) {
    deviceType = 'mobile';
  } else if (/windows|macintosh|linux/i.test(ua)) {
    deviceType = 'desktop';
  }

  if (/windows/i.test(ua)) platform = 'Windows';
  else if (/mac os|macos/i.test(ua)) platform = 'macOS';
  else if (/linux/i.test(ua)) platform = 'Linux';
  else if (/android/i.test(ua)) platform = 'Android';
  else if (/iphone|ipad/i.test(ua)) platform = 'iOS';

  if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';
  else if (/edge/i.test(ua)) browser = 'Edge';
  else if (/opera|opr/i.test(ua)) browser = 'Opera';

  return { deviceType, platform, browser };
}

/**
 * Extract client IP from request
 * @param {Object} req - Express request
 * @returns {string} Client IP
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
    || req.headers['x-real-ip'] 
    || req.socket?.remoteAddress 
    || 'unknown';
}

/**
 * Authenticate user with email/password and create session
 * @param {Object} params - Authentication parameters
 * @returns {Promise<Object>} Auth result with tokens and user
 */
async function authenticate(params) {
  const { email, password, companyId, deviceId, userAgent, ipAddress, rememberMe = false } = params;

  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!user) {
    return { success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' };
  }

  // Check account status
  if (user.status !== 'active') {
    let message = 'Account is not active';
    if (user.status === 'suspended') message = 'Account has been suspended';
    else if (user.status === 'pending_verification') message = 'Account pending verification';
    else if (user.status === 'deleted') message = 'Account has been deleted';
    return { success: false, code: 'ACCOUNT_INACTIVE', message };
  }

  // Demo accounts disabled in production
  if (user.isDemoData && String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    return { success: false, code: 'DEMO_ACCOUNT_DISABLED', message: 'Demo accounts are disabled in this environment' };
  }

  const ok = await user.verifyPassword(password);
  if (!ok) {
    // Log failed attempt
    await recordAuditEvent({
      action: 'LOGIN_FAILED',
      entityType: 'User',
      entityId: user._id,
      summary: `Failed login attempt for ${email}`,
      severity: 'warning',
      metadata: { email, ipAddress, userAgent }
    });
    return { success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' };
  }

  // Verify company membership if companyId provided
  let membership = null;
  if (companyId) {
    const Membership = require('../models/Membership');
    membership = await Membership.findOne({ user: user._id, company: companyId, isActive: true });
    if (!membership) {
      return { success: false, code: 'NO_COMPANY_ACCESS', message: 'No active membership in this company' };
    }
    // Check company status
    const Company = require('../models/Company');
    const company = await Company.findById(companyId);
    if (!company || company.status === 'suspended') {
      return { success: false, code: 'COMPANY_SUSPENDED', message: 'Company is suspended' };
    }
  } else {
    // Get user's first active membership
    const Membership = require('../models/Membership');
    membership = await Membership.findOne({ user: user._id, isActive: true }).populate('company');
    if (!membership) {
      return { success: false, code: 'NO_COMPANY_MEMBERSHIP', message: 'User has no active company membership' };
    }
  }

  const deviceInfo = parseDeviceInfo(userAgent);
  const clientIp = ipAddress || getClientIp(params.req);

  // Check for suspicious login
  const isSuspicious = await checkSuspiciousLogin(user, clientIp, deviceInfo, membership.company);

  // Create session
  const sessionResult = await Session.createSession({
    user: user._id,
    company: membership.company._id,
    deviceId: deviceId || crypto.randomBytes(16).toString('hex'),
    deviceName: deviceInfo.browser + ' on ' + deviceInfo.platform,
    deviceType: deviceInfo.deviceType,
    platform: deviceInfo.platform,
    browser: deviceInfo.browser,
    userAgent,
    ipAddress: clientIp,
    mfaVerified: false, // Will be set to true after MFA
    mfaMethod: 'none',
    expiresInDays: rememberMe ? REFRESH_TOKEN_EXPIRY_DAYS : 7
  });

  const { session, refreshToken } = sessionResult;
  const accessToken = generateAccessToken(user, session);

  // Record login
  user.recordLogin(clientIp);
  await user.save();

  // Audit log
  await recordAuditEvent({
    action: 'LOGIN_SUCCESS',
    entityType: 'User',
    entityId: user._id,
    companyId: membership.company._id,
    actor: user,
    summary: `User ${user.email} logged in`,
    severity: 'info',
    metadata: { 
      sessionId: session._id,
      deviceId: session.deviceId,
      deviceType: session.deviceType,
      ipAddress: clientIp,
      suspicious: isSuspicious,
      mfaRequired: user.mfaEnabled
    }
  });

  // If MFA is enabled, require MFA challenge
  if (user.mfaEnabled) {
    return {
      success: true,
      requiresMfa: true,
      sessionId: session._id,
      user: user.toSafeJSON(),
      message: 'MFA verification required'
    };
  }

  // Mark session as MFA verified (since MFA not required)
  session.mfaVerified = true;
  session.mfaMethod = 'none';
  await session.save();

  return {
    success: true,
    accessToken,
    refreshToken,
    user: user.toSafeJSON(),
    session: session.toSafeJSON ? session.toSafeJSON() : session
  };
}

/**
 * Check for suspicious login activity
 * @returns {Promise<boolean>}
 */
async function checkSuspiciousLogin(user, ipAddress, deviceInfo, company) {
  // Check if login from new country/region
  // Check if login from new device
  // Check for impossible travel (not implemented - would need geoip)
  // For now, just log new device
  
  const recentSessions = await Session.getActiveSessions(user._id, company._id);
  const knownDevices = new Set(recentSessions.map(s => s.deviceId));
  const knownIps = new Set(recentSessions.map(s => s.ipAddress).filter(Boolean));
  
  const isNewDevice = !knownDevices.has(deviceInfo.deviceId);
  const isNewIp = !knownIps.has(ipAddress);
  
  if (isNewDevice || isNewIp) {
    await recordAuditEvent({
      action: 'SUSPICIOUS_LOGIN',
      entityType: 'User',
      entityId: user._id,
      companyId: company._id,
      actor: user,
      summary: `Suspicious login detected for ${user.email}`,
      severity: 'warning',
      metadata: { 
        ipAddress, 
        deviceInfo, 
        isNewDevice, 
        isNewIp,
        knownDevices: Array.from(knownDevices),
        knownIps: Array.from(knownIps)
      }
    });
    return true;
  }
  
  return false;
}

/**
 * Verify MFA and complete login
 * @param {Object} params - MFA verification parameters
 * @returns {Promise<Object>} Auth result with tokens
 */
async function verifyMfa(params) {
  const { sessionId, code, method = 'totp', userId } = params;

  const session = await Session.findById(sessionId);
  if (!session || session.revokedAt) {
    return { success: false, code: 'SESSION_NOT_FOUND', message: 'Session not found or revoked' };
  }

  const user = await User.findById(session.user);
  if (!user || !user.mfaEnabled) {
    return { success: false, code: 'MFA_NOT_ENABLED', message: 'MFA is not enabled for this user' };
  }

  let verified = false;

  if (method === 'totp') {
    // Verify TOTP
    verified = speakeasy.totp.verify({
      secret: user.mfaSecret,
      encoding: 'base32',
      token: code,
      window: 1 // Allow 1 step before/after
    });
  } else if (method === 'backup_code') {
    // Verify backup code
    verified = user.verifyMfaBackupCode(code);
    if (verified) {
      await user.save();
    }
  } else if (method === 'passkey') {
    // Passkey verification would be handled separately via WebAuthn
    return { success: false, code: 'METHOD_NOT_IMPLEMENTED', message: 'Passkey verification via this endpoint not implemented' };
  }

  if (!verified) {
    await recordAuditEvent({
      action: 'MFA_FAILED',
      entityType: 'User',
      entityId: user._id,
      companyId: session.company,
      actor: user,
      summary: `MFA verification failed for ${user.email}`,
      severity: 'warning',
      metadata: { method, sessionId: session._id }
    });
    return { success: false, code: 'INVALID_MFA_CODE', message: 'Invalid MFA code' };
  }

  // Update session as MFA verified
  session.mfaVerified = true;
  session.mfaMethod = method;
  await session.save();

  const accessToken = generateAccessToken(user, session);

  await recordAuditEvent({
    action: 'MFA_VERIFIED',
    entityType: 'User',
    entityId: user._id,
    companyId: session.company,
    actor: user,
    summary: `MFA verified for ${user.email}`,
    severity: 'info',
    metadata: { method, sessionId: session._id }
  });

  return {
    success: true,
    accessToken,
    refreshToken: null, // Don't return refresh token here - client already has it
    user: user.toSafeJSON(),
    session: session.toSafeJSON ? session.toSafeJSON() : session
  };
}

/**
 * Refresh access token using refresh token
 * @param {Object} params - Refresh parameters
 * @returns {Promise<Object>} New tokens
 */
async function refreshAccessToken(params) {
  const { refreshToken, deviceId, userAgent, ipAddress } = params;

  const result = await Session.verifyAndRotate({
    refreshToken,
    deviceId,
    userAgent,
    ipAddress
  });

  if (!result.success) {
    return result;
  }

  const { session } = result;
  const user = await User.findById(session.user);
  if (!user || user.status !== 'active') {
    // Revoke session if user is inactive
    await Session.revokeSession({ sessionId: session._id, revokedReason: 'account_suspended' });
    return { success: false, code: 'USER_INACTIVE', message: 'User account is not active' };
  }

  // Check if password was changed after session creation
  if (user.passwordChangedAfter(session.createdAt)) {
    await Session.revokeAllUserSessions({ userId: user._id, revokedReason: 'password_change' });
    return { success: false, code: 'PASSWORD_CHANGED', message: 'Password was changed, please log in again' };
  }

  const accessToken = generateAccessToken(user, session);

  return {
    success: true,
    accessToken,
    refreshToken: result.refreshToken, // New rotated refresh token
    user: user.toSafeJSON()
  };
}

/**
 * Logout / revoke session
 * @param {Object} params - Logout parameters
 * @returns {Promise<Object>}
 */
async function logout(params) {
  const { sessionId, refreshToken, userId, allSessions = false } = params;

  if (allSessions && userId) {
    const count = await Session.revokeAllUserSessions({ userId, revokedReason: 'user_logout' });
    return { success: true, message: `Revoked ${count} sessions` };
  }

  if (sessionId) {
    await Session.revokeSession({ sessionId, revokedReason: 'user_logout' });
    return { success: true, message: 'Logged out successfully' };
  }

  if (refreshToken) {
    const session = await Session.findOne({ refreshTokenHash: Session.hashToken(refreshToken) });
    if (session) {
      await Session.revokeSession({ sessionId: session._id, revokedReason: 'user_logout' });
    }
    return { success: true, message: 'Logged out successfully' };
  }

  return { success: false, code: 'NO_SESSION_SPECIFIED', message: 'No session specified for logout' };
}

/**
 * Get active sessions for current user
 * @param {ObjectId} userId - User ID
 * @param {ObjectId} companyId - Company ID
 * @returns {Promise<Array>}
 */
async function getActiveSessions(userId, companyId) {
  return Session.getActiveSessions(userId, companyId);
}

/**
 * Revoke a specific session
 * @param {Object} params - Revocation parameters
 * @returns {Promise<Object>}
 */
async function revokeSession(params) {
  const { sessionId, userId, revokedBy, reason = 'admin_revoke' } = params;

  const session = await Session.findById(sessionId);
  if (!session) {
    return { success: false, code: 'SESSION_NOT_FOUND', message: 'Session not found' };
  }

  // Verify ownership or admin
  if (String(session.user) !== String(userId)) {
    // Check if revoker is admin of the company
    const Membership = require('../models/Membership');
    const membership = await Membership.findOne({ user: revokedBy, company: session.company, isActive: true });
    if (!membership || !['broker_owner', 'broker_admin', 'platform_admin'].includes(membership.role)) {
      return { success: false, code: 'FORBIDDEN', message: 'Not authorized to revoke this session' };
    }
  }

  await Session.revokeSession({ sessionId, revokedBy, revokedReason: reason });
  return { success: true, message: 'Session revoked' };
}

/**
 * Enable MFA (TOTP) for user
 * @param {Object} params - MFA setup parameters
 * @returns {Promise<Object>} Setup data with secret and QR code
 */
async function setupMfa(params) {
  const { userId } = params;

  const user = await User.findById(userId);
  if (!user) {
    return { success: false, code: 'USER_NOT_FOUND', message: 'User not found' };
  }

  if (user.mfaEnabled) {
    return { success: false, code: 'MFA_ALREADY_ENABLED', message: 'MFA is already enabled' };
  }

  // Generate secret
  const secret = speakeasy.generateSecret({
    name: `FreightBrokerCMR (${user.email})`,
    length: 32
  });

  // Store secret temporarily (not enabled until verified)
  user.mfaSecret = secret.base32;
  await user.save();

  // Generate backup codes
  const backupCodes = user.generateMfaBackupCodes(10);
  await user.save();

  return {
    success: true,
    secret: secret.base32,
    qrCode: secret.otpauth_url,
    backupCodes
  };
}

/**
 * Confirm MFA setup
 * @param {Object} params - MFA confirmation parameters
 * @returns {Promise<Object>}
 */
async function confirmMfaSetup(params) {
  const { userId, code } = params;

  const user = await User.findById(userId);
  if (!user || !user.mfaSecret) {
    return { success: false, code: 'MFA_SETUP_NOT_STARTED', message: 'MFA setup not initiated' };
  }

  const verified = speakeasy.totp.verify({
    secret: user.mfaSecret,
    encoding: 'base32',
    token: code,
    window: 1
  });

  if (!verified) {
    return { success: false, code: 'INVALID_MFA_CODE', message: 'Invalid MFA code' };
  }

  user.mfaEnabled = true;
  user.mfaVerifiedAt = new Date();
  await user.save();

  await recordAuditEvent({
    action: 'MFA_ENABLED',
    entityType: 'User',
    entityId: user._id,
    actor: user,
    summary: `MFA enabled for ${user.email}`,
    severity: 'info'
  });

  return { success: true, message: 'MFA enabled successfully' };
}

/**
 * Disable MFA
 * @param {Object} params - Disable MFA parameters
 * @returns {Promise<Object>}
 */
async function disableMfa(params) {
  const { userId, password } = params;

  const user = await User.findById(userId).select('+passwordHash');
  if (!user) {
    return { success: false, code: 'USER_NOT_FOUND', message: 'User not found' };
  }

  if (!user.mfaEnabled) {
    return { success: false, code: 'MFA_NOT_ENABLED', message: 'MFA is not enabled' };
  }

  // Verify password
  const ok = await user.verifyPassword(password);
  if (!ok) {
    return { success: false, code: 'INVALID_PASSWORD', message: 'Invalid password' };
  }

  user.mfaEnabled = false;
  user.mfaSecret = undefined;
  user.mfaBackupCodes = [];
  user.mfaVerifiedAt = undefined;
  await user.save();

  // Revoke all sessions (require re-login with MFA)
  await Session.revokeAllUserSessions({ userId, revokedReason: 'mfa_change' });

  await recordAuditEvent({
    action: 'MFA_DISABLED',
    entityType: 'User',
    entityId: user._id,
    actor: user,
    summary: `MFA disabled for ${user.email}`,
    severity: 'info'
  });

  return { success: true, message: 'MFA disabled successfully' };
}

/**
 * Regenerate MFA backup codes
 * @param {Object} params - Regeneration parameters
 * @returns {Promise<Object>}
 */
async function regenerateBackupCodes(params) {
  const { userId, password } = params;

  const user = await User.findById(userId).select('+passwordHash');
  if (!user) {
    return { success: false, code: 'USER_NOT_FOUND', message: 'User not found' };
  }

  if (!user.mfaEnabled) {
    return { success: false, code: 'MFA_NOT_ENABLED', message: 'MFA is not enabled' };
  }

  // Verify password
  const ok = await user.verifyPassword(password);
  if (!ok) {
    return { success: false, code: 'INVALID_PASSWORD', message: 'Invalid password' };
  }

  const backupCodes = user.generateMfaBackupCodes(10);
  await user.save();

  await recordAuditEvent({
    action: 'MFA_BACKUP_CODES_REGENERATED',
    entityType: 'User',
    entityId: user._id,
    actor: user,
    summary: `MFA backup codes regenerated for ${user.email}`,
    severity: 'info'
  });

  return { success: true, backupCodes };
}

/**
 * Change password (requires current password)
 * @param {Object} params - Password change parameters
 * @returns {Promise<Object>}
 */
async function changePassword(params) {
  const { userId, currentPassword, newPassword } = params;

  const user = await User.findById(userId).select('+passwordHash');
  if (!user) {
    return { success: false, code: 'USER_NOT_FOUND', message: 'User not found' };
  }

  const ok = await user.verifyPassword(currentPassword);
  if (!ok) {
    return { success: false, code: 'INVALID_PASSWORD', message: 'Current password is incorrect' };
  }

  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return { success: false, code: 'PASSWORD_TOO_SHORT', message: 'New password must be at least 8 characters' };
  }

  user.passwordHash = await User.hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await user.save();

  // Revoke all sessions except current (handled by caller)
  await Session.revokeAllUserSessions({ userId, revokedReason: 'password_change' });

  await recordAuditEvent({
    action: 'PASSWORD_CHANGED',
    entityType: 'User',
    entityId: user._id,
    actor: user,
    summary: `Password changed for ${user.email}`,
    severity: 'info'
  });

  return { success: true, message: 'Password changed successfully' };
}

/**
 * Request password reset
 * @param {Object} params - Reset request parameters
 * @returns {Promise<Object>}
 */
async function requestPasswordReset(params) {
  const { email } = params;

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    // Never reveal whether email exists
    return { success: true, message: 'If an account exists, a reset token has been issued via email.' };
  }

  if (user.status !== 'active') {
    return { success: false, code: 'ACCOUNT_INACTIVE', message: 'Account is not active' };
  }

  const token = crypto.randomBytes(32).toString('hex');
  user.passwordResetToken = crypto.createHash('sha256').update(token).digest('hex');
  user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await user.save();

  // SECURITY: Never return reset token in API response.
  // Token must be delivered via verified email channel only.
  if (process.env.NODE_ENV !== 'production') {
    console.log('[DEV] Password reset token for', email, ':', token);
  }
  // TODO: Integrate with email service
  // await emailService.sendPasswordResetEmail(email, token);

  await recordAuditEvent({
    action: 'PASSWORD_RESET_REQUESTED',
    entityType: 'User',
    entityId: user._id,
    actor: user,
    summary: `Password reset requested for ${user.email}`,
    severity: 'info',
    metadata: { email }
  });

  return { success: true, message: 'If an account exists, a reset token has been issued via email.' };
}

/**
 * Confirm password reset
 * @param {Object} params - Reset confirmation parameters
 * @returns {Promise<Object>}
 */
async function confirmPasswordReset(params) {
  const { token, newPassword } = params;

  if (!token || !newPassword) {
    return { success: false, code: 'RESET_REQUIRED', message: 'Reset token and new password are required' };
  }

  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return { success: false, code: 'PASSWORD_TOO_SHORT', message: 'New password must be at least 8 characters' };
  }

  const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = await User.findOne({
    passwordResetToken: resetTokenHash,
    passwordResetExpires: { $gt: new Date() }
  }).select('+passwordHash');

  if (!user) {
    return { success: false, code: 'INVALID_RESET_TOKEN', message: 'Invalid or expired reset token' };
  }

  user.passwordHash = await User.hashPassword(newPassword);
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.passwordChangedAt = new Date();
  await user.save();

  // Revoke all sessions
  await Session.revokeAllUserSessions({ userId: user._id, revokedReason: 'password_reset' });

  await recordAuditEvent({
    action: 'PASSWORD_RESET_CONFIRMED',
    entityType: 'User',
    entityId: user._id,
    actor: user,
    summary: `Password reset confirmed for ${user.email}`,
    severity: 'info'
  });

  return { success: true, message: 'Password reset successfully' };
}

/**
 * Add passkey credential
 * @param {Object} params - Passkey parameters
 * @returns {Promise<Object>}
 */
async function addPasskey(params) {
  const { userId, credentialId, publicKey, counter, name } = params;

  const user = await User.findById(userId);
  if (!user) {
    return { success: false, code: 'USER_NOT_FOUND', message: 'User not found' };
  }

  user.addPasskey({ credentialId, publicKey, counter, name });
  await user.save();

  await recordAuditEvent({
    action: 'PASSKEY_ADDED',
    entityType: 'User',
    entityId: user._id,
    actor: user,
    summary: `Passkey added for ${user.email}`,
    severity: 'info',
    metadata: { name }
  });

  return { success: true, message: 'Passkey added successfully' };
}

/**
 * Remove passkey
 * @param {Object} params - Passkey removal parameters
 * @returns {Promise<Object>}
 */
async function removePasskey(params) {
  const { userId, credentialId } = params;

  const user = await User.findById(userId);
  if (!user) {
    return { success: false, code: 'USER_NOT_FOUND', message: 'User not found' };
  }

  user.removePasskey(credentialId);
  await user.save();

  await recordAuditEvent({
    action: 'PASSKEY_REMOVED',
    entityType: 'User',
    entityId: user._id,
    actor: user,
    summary: `Passkey removed for ${user.email}`,
    severity: 'info',
    metadata: { credentialId }
  });

  return { success: true, message: 'Passkey removed successfully' };
}

/**
 * Mark device as trusted
 * @param {Object} params - Trust device parameters
 * @returns {Promise<Object>}
 */
async function trustDevice(params) {
  const { sessionId, userId } = params;

  const session = await Session.trustDevice({ sessionId, trustedBy: userId });
  
  await recordAuditEvent({
    action: 'DEVICE_TRUSTED',
    entityType: 'Session',
    entityId: session._id,
    companyId: session.company,
    actor: { id: userId },
    summary: `Device marked as trusted`,
    severity: 'info',
    metadata: { deviceId: session.deviceId, deviceName: session.deviceName }
  });

  return { success: true, session };
}

/**
 * Remove trusted status from device
 * @param {Object} params - Untrust device parameters
 * @returns {Promise<Object>}
 */
async function untrustDevice(params) {
  const { sessionId } = params;

  const session = await Session.untrustDevice({ sessionId });
  
  await recordAuditEvent({
    action: 'DEVICE_UNTRUSTED',
    entityType: 'Session',
    entityId: session._id,
    companyId: session.company,
    summary: `Device trust removed`,
    severity: 'info',
    metadata: { deviceId: session.deviceId, deviceName: session.deviceName }
  });

  return { success: true, session };
}

/**
 * Get login history
 * @param {Object} params - History parameters
 * @returns {Promise<Array>}
 */
async function getLoginHistory(params) {
  const { userId, companyId, limit = 50 } = params;
  return Session.getLoginHistory(userId, { limit, companyId });
}

/**
 * Cleanup expired sessions (scheduled job)
 * @returns {Promise<number>}
 */
async function cleanupExpiredSessions() {
  return Session.cleanupExpired();
}

module.exports = {
  authenticate,
  verifyMfa,
  refreshAccessToken,
  logout,
  getActiveSessions,
  revokeSession,
  setupMfa,
  confirmMfaSetup,
  disableMfa,
  regenerateBackupCodes,
  changePassword,
  requestPasswordReset,
  confirmPasswordReset,
  addPasskey,
  removePasskey,
  trustDevice,
  untrustDevice,
  getLoginHistory,
  cleanupExpiredSessions,
  generateAccessToken,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY_DAYS
};
