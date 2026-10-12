const crypto = require('crypto');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');

/**
 * @desc    Create a payment order for recharging seller wallet
 * @route   POST /api/v1/wallet/create-order
 * @access  Private
 */
const createRechargeOrder = async (req, res) => {
  try {
    const { amount, paymentMethod = 'upi' } = req.body;
    const numAmount = parseFloat(amount);

    if (isNaN(numAmount) || numAmount < 10) {
      return res.status(400).json({ error: 'Minimum recharge amount is ₹10.' });
    }
    if (numAmount > 100000) {
      return res.status(400).json({ error: 'Maximum single recharge limit is ₹1,00,000.' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const orderId = `WRECH_${user._id.toString().slice(-6)}_${Date.now()}`;

    // Fee logic: 1.9% surcharge for Card & NetBanking, 0% for UPI Instant
    const normalizedMethod = (paymentMethod || '').toLowerCase();
    const isCardOrNetbanking = normalizedMethod === 'card' || normalizedMethod === 'netbanking' || normalizedMethod === 'debit';
    const feeRate = isCardOrNetbanking ? 0.019 : 0;
    const gatewayFee = isCardOrNetbanking ? parseFloat((numAmount * 0.019).toFixed(2)) : 0;
    const totalPayable = parseFloat((numAmount + gatewayFee).toFixed(2));

    // Return order details for checkout
    res.json({
      success: true,
      orderId,
      amount: numAmount,
      gatewayFee,
      feeRate: isCardOrNetbanking ? '1.9%' : '0%',
      totalPayable,
      currency: 'INR',
      paymentMethod,
      customer: {
        name: user.fullName,
        email: user.email,
        phone: user.phone || '9876543210'
      },
      message: 'Recharge order created successfully.'
    });
  } catch (error) {
    console.error('[Wallet Controller] createRechargeOrder error:', error);
    res.status(500).json({ error: 'Failed to initiate recharge order.' });
  }
};

/**
 * @desc    Verify payment and credit the seller's wallet
 * @route   POST /api/v1/wallet/verify
 * @access  Private
 */
const verifyPayment = async (req, res) => {
  try {
    const { 
      orderId, 
      paymentId, 
      amount, 
      gateway = 'cashfree',
      signature,
      paymentMode = 'UPI',
      fee,
      totalPaid
    } = req.body;

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Invalid payment amount.' });
    }

    const effectivePaymentId = paymentId || `PAY_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    // Fee calculation for transaction ledger & receipt
    const normalizedMode = (paymentMode || '').toLowerCase();
    const isCardOrNetbanking = normalizedMode === 'card' || normalizedMode === 'netbanking' || normalizedMode === 'debit';
    const calculatedFee = fee !== undefined ? parseFloat(fee) : (isCardOrNetbanking ? parseFloat((numAmount * 0.019).toFixed(2)) : 0);
    const calculatedTotal = totalPaid !== undefined ? parseFloat(totalPaid) : parseFloat((numAmount + calculatedFee).toFixed(2));

    // 1. Idempotency Check: prevent duplicate crediting of same paymentId
    const existingTx = await WalletTransaction.findOne({
      gatewayPaymentId: effectivePaymentId,
      status: 'success'
    });

    if (existingTx) {
      const user = await User.findById(req.user._id).select('walletBalance fullName email');
      return res.json({
        success: true,
        alreadyProcessed: true,
        walletBalance: user ? user.walletBalance : 0,
        transaction: existingTx,
        message: 'Payment already verified and credited.'
      });
    }

    // 2. Atomic fetch & credit to User wallet
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const balanceBefore = parseFloat((Number(user.walletBalance) || 0).toFixed(2));
    const balanceAfter = parseFloat((balanceBefore + numAmount).toFixed(2));

    user.walletBalance = balanceAfter;
    await user.save();

    // 3. Record in WalletTransaction ledger
    const transaction = await WalletTransaction.create({
      userId: user._id,
      sellerId: user._id,
      type: 'credit',
      amount: numAmount,
      source: 'recharge',
      description: isCardOrNetbanking
        ? `Wallet top-up of ₹${numAmount.toFixed(2)} via ${paymentMode.toUpperCase()} (₹${calculatedFee.toFixed(2)} gateway fee applied)`
        : `Wallet top-up of ₹${numAmount.toFixed(2)} via UPI Instant (Zero Fee)`,
      paymentGateway: gateway,
      gatewayOrderId: orderId || `ORD_${Date.now()}`,
      gatewayPaymentId: effectivePaymentId,
      gatewaySignature: signature || '',
      balanceBefore,
      balanceAfter,
      status: 'success',
      metadata: {
        paymentMode,
        rechargeAmount: numAmount,
        gatewayFee: calculatedFee,
        totalPaid: calculatedTotal,
        feeRate: isCardOrNetbanking ? '1.9%' : '0%',
        timestamp: new Date().toISOString()
      }
    });

    console.log(`[Wallet] Seller ${user._id} recharged ₹${numAmount} (Total paid: ₹${calculatedTotal}). Balance: ₹${balanceBefore} -> ₹${balanceAfter}`);

    res.json({
      success: true,
      walletBalance: balanceAfter,
      balanceBefore,
      creditedAmount: numAmount,
      gatewayFee: calculatedFee,
      totalPaid: calculatedTotal,
      transaction,
      message: `₹${numAmount.toFixed(2)} successfully credited to your wallet!`
    });
  } catch (error) {
    console.error('[Wallet Controller] verifyPayment error:', error);
    res.status(500).json({ error: 'Failed to complete wallet credit.' });
  }
};

/**
 * @desc    Get current wallet balance & ledger summary
 * @route   GET /api/v1/wallet/balance
 * @access  Private
 */
const getWalletBalance = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('walletBalance cashbackBalance fullName email');
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const userMatch = { $or: [{ sellerId: user._id }, { userId: user._id }] };
    const recentTransactions = await WalletTransaction.find(userMatch)
      .sort({ createdAt: -1 })
      .limit(5);

    // Compute stats
    const creditAgg = await WalletTransaction.aggregate([
      { $match: { ...userMatch, type: 'credit', status: 'success' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const debitAgg = await WalletTransaction.aggregate([
      { $match: { ...userMatch, type: 'debit', status: 'success' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const totalRecharged = creditAgg.length > 0 ? parseFloat(creditAgg[0].total.toFixed(2)) : 0;
    const totalDeducted = debitAgg.length > 0 ? parseFloat(debitAgg[0].total.toFixed(2)) : 0;

    res.json({
      success: true,
      walletBalance: parseFloat((Number(user.walletBalance) || 0).toFixed(2)),
      isNegative: (Number(user.walletBalance) || 0) < 0,
      cashbackBalance: user.cashbackBalance || 0,
      totalRecharged,
      totalDeducted,
      recentTransactions
    });
  } catch (error) {
    console.error('[Wallet Controller] getWalletBalance error:', error);
    res.status(500).json({ error: 'Failed to fetch wallet balance.' });
  }
};

/**
 * @desc    Get full wallet ledger / transactions
 * @route   GET /api/v1/wallet/transactions
 * @access  Private
 */
const getTransactions = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const type = req.query.type; // 'credit' | 'debit'

    const query = { $or: [{ sellerId: req.user._id }, { userId: req.user._id }] };
    if (type && ['credit', 'debit'].includes(type)) {
      query.type = type;
    }

    const total = await WalletTransaction.countDocuments(query);
    const transactions = await WalletTransaction.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      success: true,
      transactions,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      total
    });
  } catch (error) {
    console.error('[Wallet Controller] getTransactions error:', error);
    res.status(500).json({ error: 'Failed to fetch wallet transactions.' });
  }
};

/**
 * @desc    Buyer withdraws their cashback balance
 *          Fee Rule: if withdrawal amount < ₹100 → ₹3 deducted, remaining transferred
 * @route   POST /api/v1/wallet/buyer/withdraw
 * @access  Private (Buyer / Receiver role)
 */
const withdrawCashback = async (req, res) => {
  try {
    const { amount, upiId } = req.body;
    const requested = parseFloat(amount);

    if (isNaN(requested) || requested <= 0) {
      return res.status(400).json({ error: 'Invalid withdrawal amount.' });
    }
    if (!upiId || upiId.trim() === '') {
      return res.status(400).json({ error: 'UPI ID is required for withdrawal.' });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const currentBalance = parseFloat((Number(user.cashbackBalance) || 0).toFixed(2));

    if (requested > currentBalance) {
      return res.status(400).json({
        error: `Insufficient cashback balance. Available: ₹${currentBalance.toFixed(2)}`
      });
    }

    // ── Fee Logic ────────────────────────────────────────────────────────────
    // If withdrawal amount < ₹100 → deduct ₹3 as processing fee
    const BUYER_FEE_THRESHOLD = 100;
    const BUYER_FEE = 3;
    const fee = requested < BUYER_FEE_THRESHOLD ? BUYER_FEE : 0;
    const netTransfer = parseFloat((requested - fee).toFixed(2));
    // ─────────────────────────────────────────────────────────────────────────

    if (netTransfer <= 0) {
      return res.status(400).json({
        error: `Withdrawal amount too low. After ₹${BUYER_FEE} processing fee, nothing will be transferred.`
      });
    }

    const balanceBefore = currentBalance;
    const balanceAfter = parseFloat((balanceBefore - requested).toFixed(2));

    user.cashbackBalance = balanceAfter;
    user.totalWithdrawn = parseFloat(((Number(user.totalWithdrawn) || 0) + netTransfer).toFixed(2));
    await user.save();

    // Record the withdrawal in ledger
    const transaction = await WalletTransaction.create({
      userId: user._id,
      sellerId: user._id,
      type: 'debit',
      amount: requested,
      source: 'withdrawal',
      description: `Cashback withdrawal to UPI: ${upiId}${
        fee > 0 ? ` | Processing fee: ₹${fee} (amount < ₹${BUYER_FEE_THRESHOLD})` : ''
      }`,
      paymentGateway: 'system',
      gatewayOrderId: `CBWD_${user._id.toString().slice(-6)}_${Date.now()}`,
      gatewayPaymentId: `CBPAY_${Date.now()}`,
      balanceBefore,
      balanceAfter,
      status: 'success',
      metadata: {
        withdrawalType: 'cashback',
        upiId,
        requestedAmount: requested,
        feeCharged: fee,
        netTransferred: netTransfer,
        feeThreshold: BUYER_FEE_THRESHOLD,
        timestamp: new Date().toISOString()
      }
    });

    console.log(`[Wallet] Buyer ${user._id} withdrew cashback ₹${requested} → Net ₹${netTransfer} (fee: ₹${fee}) to UPI: ${upiId}`);

    res.json({
      success: true,
      requestedAmount: requested,
      feeCharged: fee,
      netTransferred: netTransfer,
      feeApplied: fee > 0,
      feeReason: fee > 0 ? `₹${BUYER_FEE} fee applied because withdrawal was below ₹${BUYER_FEE_THRESHOLD}` : null,
      cashbackBalance: balanceAfter,
      transaction,
      message: fee > 0
        ? `₹${netTransfer.toFixed(2)} will be transferred to ${upiId} (₹${fee} processing fee deducted).`
        : `₹${netTransfer.toFixed(2)} will be transferred to ${upiId}.`
    });
  } catch (error) {
    console.error('[Wallet Controller] withdrawCashback error:', error);
    res.status(500).json({ error: 'Failed to process cashback withdrawal.' });
  }
};

/**
 * @desc    Seller withdraws their shipping wallet balance
 *          Fee Rule: if withdrawal amount < ₹2,000 → ₹2 deducted, remaining transferred
 * @route   POST /api/v1/wallet/seller/withdraw
 * @access  Private (Seller role)
 */
const withdrawWallet = async (req, res) => {
  try {
    const { amount, upiId } = req.body;
    const requested = parseFloat(amount);

    if (isNaN(requested) || requested <= 0) {
      return res.status(400).json({ error: 'Invalid withdrawal amount.' });
    }
    if (!upiId || upiId.trim() === '') {
      return res.status(400).json({ error: 'UPI ID is required for withdrawal.' });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const currentBalance = parseFloat((Number(user.walletBalance) || 0).toFixed(2));

    if (requested > currentBalance) {
      return res.status(400).json({
        error: `Insufficient wallet balance. Available: ₹${currentBalance.toFixed(2)}`
      });
    }

    // ── Fee Logic ────────────────────────────────────────────────────────────
    // If withdrawal amount < ₹2,000 → deduct ₹2 as processing fee
    const SELLER_FEE_THRESHOLD = 2000;
    const SELLER_FEE = 2;
    const fee = requested < SELLER_FEE_THRESHOLD ? SELLER_FEE : 0;
    const netTransfer = parseFloat((requested - fee).toFixed(2));
    // ─────────────────────────────────────────────────────────────────────────

    if (netTransfer <= 0) {
      return res.status(400).json({
        error: `Withdrawal amount too low. After ₹${SELLER_FEE} processing fee, nothing will be transferred.`
      });
    }

    const balanceBefore = currentBalance;
    const balanceAfter = parseFloat((balanceBefore - requested).toFixed(2));

    user.walletBalance = balanceAfter;
    user.totalWithdrawn = parseFloat(((Number(user.totalWithdrawn) || 0) + netTransfer).toFixed(2));
    await user.save();

    // Record the withdrawal in ledger
    const transaction = await WalletTransaction.create({
      userId: user._id,
      sellerId: user._id,
      type: 'debit',
      amount: requested,
      source: 'withdrawal',
      description: `Seller wallet withdrawal to UPI: ${upiId}${
        fee > 0 ? ` | Processing fee: ₹${fee} (amount < ₹${SELLER_FEE_THRESHOLD})` : ''
      }`,
      paymentGateway: 'system',
      gatewayOrderId: `WDRAW_${user._id.toString().slice(-6)}_${Date.now()}`,
      gatewayPaymentId: `WPAY_${Date.now()}`,
      balanceBefore,
      balanceAfter,
      status: 'success',
      metadata: {
        withdrawalType: 'wallet',
        upiId,
        requestedAmount: requested,
        feeCharged: fee,
        netTransferred: netTransfer,
        feeThreshold: SELLER_FEE_THRESHOLD,
        timestamp: new Date().toISOString()
      }
    });

    console.log(`[Wallet] Seller ${user._id} withdrew ₹${requested} → Net ₹${netTransfer} (fee: ₹${fee}) to UPI: ${upiId}`);

    res.json({
      success: true,
      requestedAmount: requested,
      feeCharged: fee,
      netTransferred: netTransfer,
      feeApplied: fee > 0,
      feeReason: fee > 0 ? `₹${SELLER_FEE} fee applied because withdrawal was below ₹${SELLER_FEE_THRESHOLD}` : null,
      walletBalance: balanceAfter,
      transaction,
      message: fee > 0
        ? `₹${netTransfer.toFixed(2)} will be transferred to ${upiId} (₹${fee} processing fee deducted).`
        : `₹${netTransfer.toFixed(2)} will be transferred to ${upiId}.`
    });
  } catch (error) {
    console.error('[Wallet Controller] withdrawWallet error:', error);
    res.status(500).json({ error: 'Failed to process wallet withdrawal.' });
  }
};

/**
 * @desc    Public webhook for payment gateway callbacks
 * @route   POST /api/v1/wallet/webhook
 * @access  Public
 */
const handleWebhook = async (req, res) => {
  try {
    const event = req.body;
    console.log('[Wallet Webhook] Received gateway notification event:', event?.type || 'payment');

    // Return 200 immediately to gateway
    res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('[Wallet Webhook] Error:', error);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
};

module.exports = {
  createRechargeOrder,
  verifyPayment,
  getWalletBalance,
  getTransactions,
  handleWebhook,
  withdrawCashback,
  withdrawWallet
};
