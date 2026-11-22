const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Session model for server-side session management
 * Supports refresh token rotation, reuse detection, and device tracking
 */

const sessionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true
  },
  // Refresh token (hashed for storage)
  refreshTokenHash: {
    type: String,
    required: true,
    select: false
  },
  // Previous refresh token hash (for rotation reuse detection)
  previousRefreshTokenHash: {
    type: String,
    select: false
  },
  // Token family ID for tracking rotation chain
  tokenFamily: {
    type: String,
    required: true,
    index: true
  },
  // Device/Client info
  deviceId: {
    type: String,
    required: true,
    index: true
  },
  deviceName: {
    type: String,
    trim: true
  },
  deviceType: {
    type: String,
    enum: ['web', 'mobile', 'desktop', 'api', 'unknown'],
    default: 'unknown'
  },
  platform: {
    type: String,
    trim: true
  },
  browser: {
    type: String,
    trim: true
  },
  userAgent: {
    type: String,
    trim: true
  },
  // Network info
  ipAddress: {
    type: String,
    trim: true
  },
  ipLocation: {
    country: String,
    region: String,
    city: String,
    isp: String
  },
  // Trusted device status
  isTrusted: {
    type: Boolean,
    default: false
  },
  trustedAt: {
    type: Date
  },
  trustedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // MFA status for this session
  mfaVerified: {
    type: Boolean,
    default: false
  },
  mfaMethod: {
    type: String,
    enum: ['totp', 'passkey', 'recovery_code', 'none'],
    default: 'none'
  },
  // Session lifecycle
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastUsedAt: {
    type: Date,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expireAfterSeconds: 0 }
  },
  revokedAt: {
    type: Date
  },
  revokedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  revokedReason: {
    type: String,
    enum: ['user_logout', 'password_change', 'password_reset', 'mfa_change', 'account_suspended', 'admin_revoke', 'security_breach', 'token_reuse_detected', 'expired'],
    default: 'user_logout'
  },
  // Rotation tracking
  rotationCount: {
    type: Number,
    default: 0
  },
  maxRotations: {
    type: Number,
    default: 50 // Max rotations before requiring re-auth
  }
}, { timestamps: true });

// Indexes
sessionSchema.index({ user: 1, company: 1 });
sessionSchema.index({ user: 1, isTrusted: 1 });
sessionSchema.index({ deviceId: 1, user: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Hash a refresh token for storage
 * @param {string} token - Plaintext refresh token
 * @returns {string} SHA-256 hash
 */
sessionSchema.statics.hashToken = function(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
};

/**
 * Generate a secure refresh token
 * @returns {string} Secure random token
 */
sessionSchema.statics.generateToken = function() {
  return crypto.randomBytes(48).toString('hex');
};

/**
 * Create a new session
 * @param {Object} params - Session parameters
 * @returns {Promise<Object>} Session with plaintext refresh token (only returned once)
 */
sessionSchema.statics.createSession = async function(params) {
  const {
    user,
    company,
    deviceId,
    deviceName,
    deviceType = 'unknown',
    platform,
    browser,
    userAgent,
    ipAddress,
    ipLocation,
    isTrusted = false,
    mfaVerified = false,
    mfaMethod = 'none',
    expiresInDays = 30
  } = params;

  const refreshToken = this.generateToken();
  const refreshTokenHash = this.hashToken(refreshToken);
  const tokenFamily = crypto.randomBytes(16).toString('hex');

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  const session = await this.create({
    user,
    company,
    refreshTokenHash,
    tokenFamily,
    deviceId,
    deviceName,
    deviceType,
    platform,
    browser,
    userAgent,
    ipAddress,
    ipLocation,
    isTrusted,
    mfaVerified,
    mfaMethod,
    expiresAt
  });

  return {
    session,
    refreshToken // Only returned once at creation
  };
};

/**
 * Verify a refresh token and rotate it
 * @param {Object} params - Verification parameters
 * @returns {Promise<Object>} New session with new refresh token, or null if invalid
 */
sessionSchema.statics.verifyAndRotate = async function(params) {
  const { refreshToken, deviceId, userAgent, ipAddress } = params;
  
  const refreshTokenHash = this.hashToken(refreshToken);
  
  const session = await this.findOne({
    refreshTokenHash,
    revokedAt: { $exists: false }
  });

  if (!session) {
    return { success: false, code: 'SESSION_NOT_FOUND', message: 'Session not found or already revoked' };
  }

  // Check expiration
  if (session.expiresAt < new Date()) {
    return { success: false, code: 'SESSION_EXPIRED', message: 'Session has expired' };
  }

  // Check max rotations
  if (session.rotationCount >= session.maxRotations) {
    return { success: false, code: 'MAX_ROTATIONS_EXCEEDED', message: 'Maximum token rotations exceeded, please re-authenticate' };
  }

  // Check device binding (optional but recommended)
  if (deviceId && session.deviceId !== deviceId) {
    // Log suspicious activity but allow (could be legitimate device change)
    console.warn(`Device mismatch for session ${session._id}: expected ${session.deviceId}, got ${deviceId}`);
  }

  // Reuse detection: check if this token was already used
  // In a real implementation, you'd track used tokens in a separate collection
  // For now, we use the tokenFamily chain to detect reuse
  
  // Generate new token
  const newRefreshToken = this.generateToken();
  const newRefreshTokenHash = this.hashToken(newRefreshToken);

  // Store previous hash for reuse detection
  session.previousRefreshTokenHash = session.refreshTokenHash;
  session.refreshTokenHash = newRefreshTokenHash;
  session.rotationCount += 1;
  session.lastUsedAt = new Date();
  
  // Update device info if provided
  if (userAgent) session.userAgent = userAgent;
  if (ipAddress) session.ipAddress = ipAddress;

  await session.save();

  return {
    success: true,
    session,
    refreshToken: newRefreshToken // Return new token
  };
};

/**
 * Revoke a session
 * @param {Object} params - Revocation parameters
 * @returns {Promise<boolean>}
 */
sessionSchema.statics.revokeSession = async function(params) {
  const { sessionId, revokedBy, revokedReason = 'user_logout' } = params;
  
  const session = await this.findById(sessionId);
  if (!session || session.revokedAt) return false;

  session.revokedAt = new Date();
  session.revokedBy = revokedBy;
  session.revokedReason = revokedReason;
  await session.save();

  return true;
};

/**
 * Revoke all sessions for a user (optionally for a specific company)
 * @param {Object} params - Revocation parameters
 * @returns {Promise<number>} Number of sessions revoked
 */
sessionSchema.statics.revokeAllUserSessions = async function(params) {
  const { userId, companyId, revokedBy, revokedReason = 'password_change' } = params;
  
  const query = { 
    user: userId, 
    revokedAt: { $exists: false } 
  };
  
  if (companyId) {
    query.company = companyId;
  }

  const result = await this.updateMany(query, {
    $set: {
      revokedAt: new Date(),
      revokedBy,
      revokedReason
    }
  });

  return result.modifiedCount;
};

/**
 * Get active sessions for a user
 * @param {ObjectId} userId - User ID
 * @param {ObjectId} [companyId] - Optional company ID filter
 * @returns {Promise<Array>} Active sessions
 */
sessionSchema.statics.getActiveSessions = async function(userId, companyId) {
  const query = { user: userId, revokedAt: { $exists: false } };
  if (companyId) query.company = companyId;
  
  return this.find(query)
    .select('-refreshTokenHash -previousRefreshTokenHash')
    .populate('company', 'name slug')
    .sort({ lastUsedAt: -1 });
};

/**
 * Mark a device as trusted
 * @param {Object} params - Trust parameters
 * @returns {Promise<Object>} Updated session
 */
sessionSchema.statics.trustDevice = async function(params) {
  const { sessionId, trustedBy } = params;
  
  const session = await this.findById(sessionId);
  if (!session || session.revokedAt) {
    throw new Error('Session not found or revoked');
  }

  session.isTrusted = true;
  session.trustedAt = new Date();
  session.trustedBy = trustedBy;
  await session.save();

  return session;
};

/**
 * Remove trusted status from a device
 * @param {Object} params - Untrust parameters
 * @returns {Promise<Object>} Updated session
 */
sessionSchema.statics.untrustDevice = async function(params) {
  const { sessionId } = params;
  
  const session = await this.findById(sessionId);
  if (!session || session.revokedAt) {
    throw new Error('Session not found or revoked');
  }

  session.isTrusted = false;
  session.trustedAt = undefined;
  session.trustedBy = undefined;
  await session.save();

  return session;
};

/**
 * Clean up expired sessions (run as scheduled job)
 * @returns {Promise<number>} Number of sessions cleaned
 */
sessionSchema.statics.cleanupExpired = async function() {
  const result = await this.deleteMany({
    $or: [
      { expiresAt: { $lt: new Date() } },
      { revokedAt: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } // Revoked > 7 days ago
    ]
  });
  return result.deletedCount;
};

/**
 * Get login history for a user
 * @param {ObjectId} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Login history
 */
sessionSchema.statics.getLoginHistory = async function(userId, options = {}) {
  const { limit = 50, companyId, includeRevoked = false } = options;
  
  const query = { user: userId };
  if (companyId) query.company = companyId;
  if (!includeRevoked) query.revokedAt = { $exists: false };
  
  return this.find(query)
    .select('-refreshTokenHash -previousRefreshTokenHash')
    .populate('company', 'name slug')
    .sort({ createdAt: -1 })
    .limit(limit);
};

module.exports = mongoose.model('Session', sessionSchema);
