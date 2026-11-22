const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

/**
 * User model for JWT authentication (demo + real accounts).
 * Roles: broker (default), compliance_officer, admin.
 * Passwords are bcrypt-hashed; never returned in API responses.
 */

const userSchema = new mongoose.Schema({
  name: { type: String, required: [true, 'Name is required'], trim: true },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    trim: true,
    lowercase: true,
    index: true
  },
  passwordHash: { type: String, required: true, select: false },
  role: {
    type: String,
    enum: ['broker', 'compliance_officer', 'admin', 'broker_owner', 'broker_admin', 'operations_manager', 'finance', 'viewer',
           'carrier_owner', 'carrier_admin', 'dispatcher', 'driver',
           'platform_admin', 'platform_support'],
    default: 'broker',
    required: true
  },
  isDemoData: { type: Boolean, default: false },
  // Account status
  status: {
    type: String,
    enum: ['active', 'suspended', 'pending_verification', 'deleted'],
    default: 'active',
    index: true
  },
  // Last password change (for session invalidation)
  passwordChangedAt: { type: Date },
  // Password reset support (server-authoritative; tokens never returned to client)
  passwordResetToken: { type: String, trim: true, select: false },
  passwordResetExpires: { type: Date, select: false },
  // MFA / TOTP
  mfaEnabled: { type: Boolean, default: false },
  mfaSecret: { type: String, select: false },
  mfaBackupCodes: [{ type: String, select: false }],
  mfaVerifiedAt: { type: Date },
  // Passkey/WebAuthn credentials
  passkeys: [{
    credentialId: { type: String, required: true },
    publicKey: { type: String, required: true },
    counter: { type: Number, default: 0 },
    name: { type: String }, // User-friendly name
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date }
  }],
  // Security settings
  requireMfaForCompany: { type: Boolean, default: false }, // Per-user preference
  lastSecurityReviewAt: { type: Date },
  // Login tracking
  lastLoginAt: { type: Date },
  lastLoginIp: { type: String },
  loginCount: { type: Number, default: 0 },
  // Account recovery
  recoveryEmail: { type: String, trim: true, lowercase: true },
  recoveryPhone: { type: String, trim: true }
}, { timestamps: true });

// Hash a plaintext password (bcrypt, cost 10)
userSchema.statics.hashPassword = async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, 10);
};

// Verify a plaintext password against the stored hash
userSchema.methods.verifyPassword = function verifyPassword(plaintext) {
  return bcrypt.compare(plaintext, this.passwordHash);
};

// Safe public representation (never includes passwordHash, mfaSecret, etc.)
userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    name: this.name,
    email: this.email,
    role: this.role,
    status: this.status,
    mfaEnabled: this.mfaEnabled,
    mfaVerifiedAt: this.mfaVerifiedAt,
    passkeyCount: this.passkeys?.length || 0,
    lastLoginAt: this.lastLoginAt,
    loginCount: this.loginCount,
    createdAt: this.createdAt
  };
};

/**
 * Check if password was changed after a given date (for session invalidation)
 * @param {Date} date - Date to compare against
 * @returns {boolean}
 */
userSchema.methods.passwordChangedAfter = function(date) {
  if (!this.passwordChangedAt) return false;
  return this.passwordChangedAt > date;
};

/**
 * Generate MFA backup codes
 * @param {number} count - Number of codes to generate
 * @returns {string[]} Array of backup codes
 */
userSchema.methods.generateMfaBackupCodes = function(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  // Hash before storing
  this.mfaBackupCodes = codes.map(code => crypto.createHash('sha256').update(code).digest('hex'));
  return codes; // Return plaintext codes once
};

/**
 * Verify a backup code
 * @param {string} code - Plaintext backup code
 * @returns {boolean} Whether code is valid and unused
 */
userSchema.methods.verifyMfaBackupCode = function(code) {
  const hashedCode = crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
  const index = this.mfaBackupCodes.indexOf(hashedCode);
  if (index === -1) return false;
  // Remove used code (single-use)
  this.mfaBackupCodes.splice(index, 1);
  return true;
};

/**
 * Add a passkey credential
 * @param {Object} passkey - Passkey data
 */
userSchema.methods.addPasskey = function(passkey) {
  this.passkeys.push({
    credentialId: passkey.credentialId,
    publicKey: passkey.publicKey,
    counter: passkey.counter || 0,
    name: passkey.name,
    createdAt: new Date()
  });
};

/**
 * Update passkey counter (for WebAuthn)
 * @param {string} credentialId - Credential ID
 * @param {number} counter - New counter value
 */
userSchema.methods.updatePasskeyCounter = function(credentialId, counter) {
  const pk = this.passkeys.find(p => p.credentialId === credentialId);
  if (pk) {
    pk.counter = counter;
    pk.lastUsedAt = new Date();
  }
};

/**
 * Remove a passkey
 * @param {string} credentialId - Credential ID to remove
 */
userSchema.methods.removePasskey = function(credentialId) {
  this.passkeys = this.passkeys.filter(p => p.credentialId !== credentialId);
};

/**
 * Record successful login
 * @param {string} ip - IP address
 */
userSchema.methods.recordLogin = function(ip) {
  this.lastLoginAt = new Date();
  this.lastLoginIp = ip;
  this.loginCount += 1;
};

module.exports = mongoose.model('User', userSchema);
