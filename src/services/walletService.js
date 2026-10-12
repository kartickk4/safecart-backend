const WalletTransaction = require('../models/WalletTransaction');

/**
 * Record a ledger entry in WalletTransaction
 * Automatically supports both buyers and sellers, guaranteeing full audit trail.
 */
const recordTransaction = async ({
  userId,
  type, // 'credit' | 'debit'
  amount,
  source, // 'recharge', 'escrow_settlement', 'freight_deduction', 'cod_fee_deduction', 'refund', 'admin_adjustment', 'withdrawal'
  description = '',
  paymentGateway = 'system',
  gatewayOrderId,
  gatewayPaymentId,
  gatewaySignature = '',
  balanceBefore = 0,
  balanceAfter = 0,
  status = 'success',
  metadata = {}
}) => {
  try {
    if (!userId || !amount || !type || !source) {
      console.warn('[WalletService] Missing required fields for wallet transaction record:', { userId, amount, type, source });
      return null;
    }

    const tx = await WalletTransaction.create({
      userId,
      sellerId: userId, // for backward compatibility with existing queries
      type,
      amount: parseFloat(Number(amount).toFixed(2)),
      source,
      description,
      paymentGateway,
      gatewayOrderId: gatewayOrderId || `ORD_${Date.now()}`,
      gatewayPaymentId: gatewayPaymentId || `PAY_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      gatewaySignature,
      balanceBefore: parseFloat(Number(balanceBefore).toFixed(2)),
      balanceAfter: parseFloat(Number(balanceAfter).toFixed(2)),
      status,
      metadata: {
        ...metadata,
        recordedAt: new Date().toISOString()
      }
    });

    return tx;
  } catch (error) {
    console.error('[WalletService] Failed to record wallet transaction:', error.message);
    return null;
  }
};

module.exports = {
  recordTransaction
};
