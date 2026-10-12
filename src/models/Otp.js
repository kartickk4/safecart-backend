const mongoose = require('mongoose');

const OtpSchema = new mongoose.Schema({
  identifier: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  otp: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['phone', 'email', 'password_reset'],
    required: true
  },
  role: {
    type: String,
    enum: ['User', 'Supplier', 'Receiver', 'Admin'],
    default: 'Receiver'
  },

  createdAt: {
    type: Date,
    default: Date.now,
    expires: 300 // Automatically removed from MongoDB after 5 minutes (300 seconds)
  }
});

// Index for fast lookup by identifier + type + role
OtpSchema.index({ identifier: 1, type: 1, role: 1 });

module.exports = mongoose.model('Otp', OtpSchema);
