const mongoose = require('mongoose');

const WalletTransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
    // index defined below as composite with createdAt
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
    // index defined below as composite with createdAt
  },
  type: {
    type: String,
    enum: ['credit', 'debit'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0.01
  },
  source: {
    type: String,
    enum: [
      'recharge',
      'escrow_settlement',
      'freight_deduction',
      'cod_fee_deduction',
      'refund',
      'admin_adjustment',
      'withdrawal'
    ],
    required: true,
    index: true
  },
  description: {
    type: String,
    default: ''
  },
  paymentGateway: {
    type: String,
    enum: ['cashfree', 'razorpay', 'upi', 'system', 'admin'],
    default: 'cashfree'
  },
  gatewayOrderId: {
    type: String,
    sparse: true,
    index: true
  },
  gatewayPaymentId: {
    type: String,
    sparse: true,
    index: true
  },
  gatewaySignature: {
    type: String,
    default: ''
  },
  balanceBefore: {
    type: Number,
    required: true
  },
  balanceAfter: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'pending',
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// ── Performance & Query Indexes ───────────────────────────────────────────────
//
// COMPOSITE — Wallet history sorted by most recent (most frequent query pattern).
// Covers: WalletTransaction.find({ sellerId }).sort({ createdAt: -1 })
// Supersedes the old single-field { sellerId: 1 } index via prefix.
WalletTransactionSchema.index({ sellerId: 1, createdAt: -1 });

// COMPOSITE — Buyer-side wallet history sorted by most recent.
// Covers: WalletTransaction.find({ userId }).sort({ createdAt: -1 })
// Supersedes the old single-field { userId: 1 } index via prefix.
WalletTransactionSchema.index({ userId: 1, createdAt: -1 });

// ── Redundant single-field indexes (commented out — superseded by composites above) ──
// { sellerId: 1 } — superseded by { sellerId: 1, createdAt: -1 }
// { userId: 1 }   — superseded by { userId: 1, createdAt: -1 }
// Note: To drop the old indexes from MongoDB Atlas, run the migration script.

module.exports = mongoose.model('WalletTransaction', WalletTransactionSchema);
