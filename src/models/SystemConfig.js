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
  cashbackMarketingBonusAmount: {
    type: Number,
    default: 10
  },
  cashbackMinWithdrawal: {
    type: Number,
    default: 50
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
