const mongoose = require('mongoose');

const SystemConfigSchema = new mongoose.Schema({
  configKey: {
    type: String,
    default: 'GLOBAL_CONFIG',
    unique: true
  },
  gatewayFeeRate: {
    type: Number,
    default: 0, // 0% (Free escrow)
    min: 0,
    max: 10
  },
  returnWindowHours: {
    type: Number,
    default: 24,
    min: 1
  },
  confirmationWindowHours: {
    type: Number,
    default: 24,
    min: 1
  },
  cashbackEnabled: {
    type: Boolean,
    default: true
  },
  cashbackMarketingBonusActive: {
    type: Boolean,
    default: false
  },
  cashbackMarketingBonusMin: {
    type: Number,
    default: 1, // ₹1 min promotional cashback
    min: 1
  },
  cashbackMarketingBonusMax: {
    type: Number,
    default: 10, // ₹10 max promotional cashback
    min: 1
  },
  cashbackMarketingBonusAmount: {
    type: Number,
    default: 10
  },
  cashbackMinWithdrawal: {
    type: Number,
    default: 50
  },
  sellerCashbackMin: {
    type: Number,
    default: 3, // ₹3 minimum seller cashback per completed shipment
    min: 0
  },
  sellerCashbackMax: {
    type: Number,
    default: 6, // ₹6 maximum seller cashback per completed shipment
    min: 0
  },
  paymentLinkCashbackAmount: {
    type: Number,
    default: 5, // Flat ₹5 for paying via Payment Link
    min: 0
  },
  deliveryConfirmCashbackAmount: {
    type: Number,
    default: 2, // Flat ₹2 for buyers on confirming delivery
    min: 0
  },
  buyerCashbackRate: {
    type: Number,
    default: 2.0, // 2% buyer prepayment cashback
    min: 0,
    max: 10
  },
  buyerCashbackMaxCap: {
    type: Number,
    default: 10, // Max ₹10 cap for buyer rewards
    min: 0
  },
  photoReviewFee: {
    type: Number,
    default: 2,
    min: 0
  },
  undeliveredPenaltyReceiver: {
    type: Number,
    default: 40,
    min: 0
  },
  undeliveredReliefSupplier: {
    type: Number,
    default: 20,
    min: 0
  },
  mockCarrierEnabled: {
    type: Boolean,
    default: true
  },
  maintenanceMode: {
    type: Boolean,
    default: false
  },
  supportEmail: {
    type: String,
    default: 'support@securekaro.in'
  },
  supportPhone: {
    type: String,
    default: '+91 98765 43210'
  },
  updatedBy: {
    type: String,
    default: 'system'
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('SystemConfig', SystemConfigSchema);
