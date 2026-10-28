const mongoose = require('mongoose');

const RewardSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  shipmentId: {
    type: String,
    default: ""
  },
  type: {
    type: String,
    enum: ['CASHBACK_EARNED', 'ESCROW_INTEREST_EARNED', 'WITHDRAWAL'],
    required: true
  },
  category: {
    type: String,
    enum: ['PREPAYMENT_REWARD', 'ESCROW_YIELD', 'RETURN_INTEREST_SPLIT', 'WITHDRAWAL', 'DELIVERY_CONFIRMATION_REWARD', 'SELLER_SHIPPING_CASHBACK', 'SUPPLIER_CASHBACK', 'WELCOME_FIRST_ORDER_CASHBACK'],
    default: 'PREPAYMENT_REWARD'
  },
  role: {
    type: String,
    enum: ['Supplier', 'Receiver', 'User', 'Admin'],
    default: 'User'
  },
  amount: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['CREDITED', 'WITHDRAWN', 'PENDING', 'FAILED'],
    default: 'CREDITED'
  },
  payoutMethod: {
    type: String,
    enum: ['BANK', 'UPI', 'NONE'],
    default: 'NONE'
  },
  payoutDetails: {
    accountHolderName: { type: String, default: "" },
    accountNumber: { type: String, default: "" },
    ifscCode: { type: String, default: "" },
    bankName: { type: String, default: "" },
    upiId: { type: String, default: "" }
  },
  description: {
    type: String,
    default: ""
  },
  transferId: {
    type: String,
    default: ""
  },
  transferMode: {
    type: String,
    default: ""
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Performance & Wallet History Indexes
RewardSchema.index({ userId: 1, createdAt: -1 });
RewardSchema.index({ shipmentId: 1 });
RewardSchema.index({ type: 1 });

module.exports = mongoose.model('Reward', RewardSchema);
