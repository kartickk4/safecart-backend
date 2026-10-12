const mongoose = require('mongoose');

const WalletTransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
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

module.exports = mongoose.model('WalletTransaction', WalletTransactionSchema);
