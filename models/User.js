const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

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
    enum: ['broker', 'compliance_officer', 'admin'],
    default: 'broker',
    required: true
  },
  isDemoData: { type: Boolean, default: false }
}, { timestamps: true });

// Hash a plaintext password (bcrypt, cost 10)
userSchema.statics.hashPassword = async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, 10);
};

// Verify a plaintext password against the stored hash
userSchema.methods.verifyPassword = function verifyPassword(plaintext) {
  return bcrypt.compare(plaintext, this.passwordHash);
};

// Safe public representation (never includes passwordHash)
userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    name: this.name,
    email: this.email,
    role: this.role
  };
};

module.exports = mongoose.model('User', userSchema);
