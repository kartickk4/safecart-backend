const crypto = require('crypto');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const phonepeService = require('../services/phonepeService');
const cashfreeService = phonepeService; // Backwards-compatible alias
const { getActiveShipmentsCount, calculateSecurityReserve } = require('../utils/securityReserve');
const {
  checkCoolingPeriod,
  checkWithdrawalVelocity,
  USER_DAILY_LIMIT,
  HIGH_VALUE_APPROVAL_THRESHOLD
} = require('../middleware/walletSecurity');
const { createNotification } = require('../services/notification');

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
      gateway = 'phonepe',
      signature,
      paymentMode = 'UPI',
      fee,
      totalPaid
    } = req.body;

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Invalid payment amount.' });
    }

    if (!paymentId || typeof paymentId !== 'string' || !paymentId.trim()) {
      return res.status(400).json({ error: 'A valid gateway payment ID is required for verification.' });
    }
    const effectivePaymentId = paymentId.trim();

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

    // 2. Gateway Verification: Never trust client-side claims alone
    const normalizedGateway = (gateway || 'phonepe').toLowerCase();
    if (normalizedGateway === 'phonepe' || normalizedGateway === 'cashfree') {
      const verification = await phonepeService.verifyPaymentWithGateway({
        orderId: orderId || effectivePaymentId,
        paymentId: effectivePaymentId,
        expectedAmount: calculatedTotal || numAmount,
        expectedCurrency: 'INR'
      });

      if (!verification.verified) {
        console.warn(`[Wallet Recharge Security] Payment verification failed for user ${req.user._id}: ${verification.error}`);
        return res.status(400).json({
          error: verification.error || 'Payment verification failed with PhonePe gateway. Wallet was not credited.'
        });
      }
    }

    // 3. Fetch current balance snapshot
    const userSnapshot = await User.findById(req.user._id);
    if (!userSnapshot) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const balanceBefore = parseFloat((Number(userSnapshot.walletBalance) || 0).toFixed(2));

    // 4. Atomic credit to User wallet to prevent race condition lost updates
    const user = await User.findOneAndUpdate(
      { _id: req.user._id },
      { $inc: { walletBalance: numAmount } },
      { new: true }
    );
    const balanceAfter = parseFloat((Number(user.walletBalance) || 0).toFixed(2));

    // 3. Record in WalletTransaction ledger
    const transaction = await WalletTransaction.create({
      userId: user._id,
      sellerId: user._id,
      walletType: 'seller',
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
    const user = req.user || await User.findById(req.user._id).select('walletBalance cashbackBalance fullName email');
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const userMatch = { $or: [{ sellerId: user._id }, { userId: user._id }] };

    // Parallelize recent transactions lookup and combined credit/debit aggregation
    const [recentTransactions, typeAgg] = await Promise.all([
      WalletTransaction.find(userMatch)
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
      WalletTransaction.aggregate([
        { $match: { ...userMatch, status: 'success', type: { $in: ['credit', 'debit'] } } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } }
      ])
    ]);

    let totalRecharged = 0;
    let totalDeducted = 0;
    for (const item of typeAgg) {
      if (item._id === 'credit') totalRecharged = parseFloat(Number(item.total).toFixed(2));
      if (item._id === 'debit') totalDeducted = parseFloat(Number(item.total).toFixed(2));
    }

    const currentBalance = parseFloat((Number(user.walletBalance) || 0).toFixed(2));
    const activeShipmentsCount = await getActiveShipmentsCount(user._id);
    const securityReserve = calculateSecurityReserve(activeShipmentsCount);
    const withdrawableBalance = Math.max(0, parseFloat((currentBalance - securityReserve).toFixed(2)));

    res.json({
      success: true,
      // ── Strict Role Separation: Seller Wallet vs Buyer Cashback ─────────
      sellerWallet: {
        balance: currentBalance,
        isNegative: currentBalance < 0,
        activeShipmentsCount,
        securityReserve,
        withdrawableBalance,
        reservePerShipment: 100,
        maxReserveCap: 1000,
        totalRecharged,
        totalDeducted
      },
      buyerWallet: {
        cashbackBalance: user.cashbackBalance || 0,
        withdrawableBalance: user.cashbackBalance || 0
      },
      // ── Backward-Compatible Top-Level Keys ────────────────────────────────
      walletBalance: currentBalance,
      isNegative: currentBalance < 0,
      activeShipmentsCount,
      securityReserve,
      withdrawableBalance,
      reservePerShipment: 100,
      maxReserveCap: 1000,
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
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const type = req.query.type; // 'credit' | 'debit'
    const walletType = req.query.walletType; // 'seller' | 'buyer_cashback'

    const query = { $or: [{ sellerId: req.user._id }, { userId: req.user._id }] };
    if (type && ['credit', 'debit'].includes(type)) {
      query.type = type;
    }
    if (walletType && ['seller', 'buyer_cashback'].includes(walletType)) {
      query.walletType = walletType;
    }

    // Execute count and paginated query in parallel
    const [total, transactions] = await Promise.all([
      WalletTransaction.countDocuments(query),
      WalletTransaction.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ]);

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

    const currentSnapshot = await User.findById(req.user._id);
    if (!currentSnapshot) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // ── Banking Security 1: Payout Destination Cooling-Off Period ─────────
    const cooling = checkCoolingPeriod(currentSnapshot, upiId);
    if (cooling.locked) {
      return res.status(403).json({
        error: cooling.message,
        coolingPeriodActive: true,
        unlocksAt: cooling.unlocksAt,
        remainingMinutes: cooling.remainingMinutes
      });
    }

    // ── Banking Security 2: Daily Velocity Limit & Circuit Breaker ────────
    const velocity = await checkWithdrawalVelocity(req.user._id, requested);
    if (!velocity.allowed) {
      return res.status(400).json({
        error: velocity.reason,
        circuitBreakerTripped: velocity.circuitBreakerTripped || false
      });
    }

    // ── Banking Security 3: Idempotency Key Guard (Anti-Duplicate Clicks) ──
    const idempotencyKey = req.headers['x-idempotency-key'] || `IDEMP_CB_${req.user._id}_${requested}_${upiId}_${Math.floor(Date.now() / 30000)}`;
    const existingTx = await WalletTransaction.findOne({
      idempotencyKey,
      status: { $in: ['success', 'pending'] }
    });
    if (existingTx) {
      return res.json({
        success: true,
        alreadyProcessed: true,
        transaction: existingTx,
        message: 'This withdrawal request has already been processed.'
      });
    }

    const currentCashback = Number(currentSnapshot.cashbackBalance) || 0;

    // Strict Segregation Rule: Buyer cashback withdrawals CANNOT touch or draw from seller wallet balance!
    if (requested > currentCashback) {
      return res.status(400).json({
        error: `Insufficient buyer cashback balance. Available cashback to withdraw: ₹${currentCashback.toFixed(2)}. Seller shipping wallet funds cannot be accessed or mixed via buyer cashback withdrawal.`
      });
    }

    // High value threshold: amounts > ₹10,000 flagged for admin security verification
    const requiresAdminApproval = velocity.requiresAdminApproval;
    const initialStatus = requiresAdminApproval ? 'pending' : 'success';

    // Atomic deduction: strictly from cashbackBalance only (walletBalance is NEVER touched)
    const user = await User.findOneAndUpdate(
      { 
        _id: req.user._id, 
        cashbackBalance: { $gte: requested }
      },
      { 
        $inc: { 
          cashbackBalance: -requested,
          totalWithdrawn: netTransfer
        } 
      },
      { new: true }
    );

    if (!user) {
      const freshSnapshot = await User.findById(req.user._id);
      const available = freshSnapshot ? (freshSnapshot.cashbackBalance || 0) : 0;
      return res.status(400).json({
        error: `Insufficient cashback balance or concurrent transaction in progress. Available: ₹${available.toFixed(2)}`
      });
    }

    const balanceAfter = parseFloat((Number(user.cashbackBalance) || 0).toFixed(2));
    const balanceBefore = parseFloat((balanceAfter + requested).toFixed(2));

    // Record the withdrawal in immutable double-entry ledger with explicit walletType
    const transaction = await WalletTransaction.create({
      userId: user._id,
      sellerId: user._id,
      walletType: 'buyer_cashback',
      type: 'debit',
      amount: requested,
      source: 'cashback_withdrawal',
      description: `Buyer cashback withdrawal to UPI: ${upiId}${
        fee > 0 ? ` | Processing fee: ₹${fee} (amount < ₹${BUYER_FEE_THRESHOLD})` : ''
      }${requiresAdminApproval ? ' [High-Value Review Queued]' : ''}`,
      paymentGateway: 'system',
      gatewayOrderId: `CBWD_${user._id.toString().slice(-6)}_${Date.now()}`,
      gatewayPaymentId: `CBPAY_${Date.now()}`,
      idempotencyKey,
      balanceBefore,
      balanceAfter,
      status: initialStatus,
      metadata: {
        walletType: 'buyer_cashback',
        withdrawalType: 'cashback',
        upiId,
        requestedAmount: requested,
        feeCharged: fee,
        netTransferred: netTransfer,
        feeThreshold: BUYER_FEE_THRESHOLD,
        requiresAdminApproval,
        timestamp: new Date().toISOString()
      }
    });

    if (requiresAdminApproval) {
      console.log(`[FINTECH AUDIT] High-value buyer withdrawal (₹${requested}) by ${user._id} queued for review.`);
      try {
        await createNotification(
          user._id,
          'security',
          '🔒 High-Value Withdrawal Security Verification',
          `Your withdrawal request of ₹${requested.toLocaleString('en-IN')} has been received. For amounts exceeding ₹10,000, our banking security protocol performs an automated verification review. Funds will be transferred to ${upiId} shortly.`,
          'payment'
        );
      } catch (_) {}
    }

    console.log(`[Wallet] Buyer ${user._id} withdrew cashback ₹${requested} → Net ₹${netTransfer} (fee: ₹${fee}) to UPI: ${upiId} [Status: ${initialStatus}]`);

    res.json({
      success: true,
      requestedAmount: requested,
      feeCharged: fee,
      netTransferred: netTransfer,
      feeApplied: fee > 0,
      feeReason: fee > 0 ? `₹${BUYER_FEE} fee applied because withdrawal was below ₹${BUYER_FEE_THRESHOLD}` : null,
      cashbackBalance: user.cashbackBalance || 0,
      withdrawableBalance: parseFloat((Number(user.cashbackBalance) || 0).toFixed(2)),
      walletType: 'buyer_cashback',
      requiresAdminApproval,
      status: initialStatus,
      transaction,
      message: requiresAdminApproval
        ? `₹${netTransfer.toFixed(2)} withdrawal requested. For amounts over ₹10,000, banking security verification is performed. Transferring to ${upiId} shortly.`
        : (fee > 0
            ? `₹${netTransfer.toFixed(2)} will be transferred to ${upiId} (₹${fee} processing fee deducted).`
            : `₹${netTransfer.toFixed(2)} will be transferred to ${upiId}.`)
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

    // ── Dynamic Minimum Wallet Security Reserve Buffer Check ────────────────
    // Sellers must maintain a minimum wallet balance: ₹100 per active shipment, capped at ₹1,000 max.
    const activeShipmentsCount = await getActiveShipmentsCount(req.user._id);
    const requiredReserve = calculateSecurityReserve(activeShipmentsCount);

    const currentSnapshot = await User.findById(req.user._id);
    if (!currentSnapshot) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // ── Banking Security 1: Payout Destination Cooling-Off Period ─────────
    const cooling = checkCoolingPeriod(currentSnapshot, upiId);
    if (cooling.locked) {
      return res.status(403).json({
        error: cooling.message,
        coolingPeriodActive: true,
        unlocksAt: cooling.unlocksAt,
        remainingMinutes: cooling.remainingMinutes
      });
    }

    // ── Banking Security 2: Daily Velocity Limit & Circuit Breaker ────────
    const velocity = await checkWithdrawalVelocity(req.user._id, requested);
    if (!velocity.allowed) {
      return res.status(400).json({
        error: velocity.reason,
        circuitBreakerTripped: velocity.circuitBreakerTripped || false
      });
    }

    // ── Banking Security 3: Idempotency Key Guard (Anti-Duplicate Clicks) ──
    const idempotencyKey = req.headers['x-idempotency-key'] || `IDEMP_W_${req.user._id}_${requested}_${upiId}_${Math.floor(Date.now() / 30000)}`;
    const existingTx = await WalletTransaction.findOne({
      idempotencyKey,
      status: { $in: ['success', 'pending'] }
    });
    if (existingTx) {
      return res.json({
        success: true,
        alreadyProcessed: true,
        transaction: existingTx,
        message: 'This withdrawal request has already been processed.'
      });
    }

    const currentBalance = Number(currentSnapshot.walletBalance) || 0;
    const maxWithdrawable = Math.max(0, parseFloat((currentBalance - requiredReserve).toFixed(2)));

    if (requested > maxWithdrawable) {
      return res.status(400).json({
        error: `Cannot withdraw ₹${requested}. You have ${activeShipmentsCount} active shipment(s) requiring a minimum wallet security buffer of ₹${requiredReserve} (₹100/shipment, max ₹1,000). Maximum withdrawable balance is ₹${maxWithdrawable.toFixed(2)}.`
      });
    }

    // High value threshold: amounts > ₹10,000 flagged for admin security verification
    const requiresAdminApproval = velocity.requiresAdminApproval;
    const initialStatus = requiresAdminApproval ? 'pending' : 'success';

    // Atomic deduction: prevents double-spending race conditions while guaranteeing reserve buffer
    const user = await User.findOneAndUpdate(
      { _id: req.user._id, walletBalance: { $gte: requested + requiredReserve } },
      { 
        $inc: { 
          walletBalance: -requested,
          totalWithdrawn: netTransfer
        } 
      },
      { new: true }
    );

    if (!user) {
      const freshSnapshot = await User.findById(req.user._id);
      const available = freshSnapshot ? freshSnapshot.walletBalance : 0;
      return res.status(400).json({
        error: `Insufficient withdrawable wallet balance (minimum ₹${requiredReserve} security buffer must be retained for ${activeShipmentsCount} active shipment(s)). Available: ₹${available.toFixed(2)}`
      });
    }

    const balanceAfter = parseFloat((Number(user.walletBalance) || 0).toFixed(2));
    const balanceBefore = parseFloat((balanceAfter + requested).toFixed(2));

    // Record the withdrawal in immutable double-entry ledger
    const transaction = await WalletTransaction.create({
      userId: user._id,
      sellerId: user._id,
      walletType: 'seller',
      type: 'debit',
      amount: requested,
      source: 'withdrawal',
      description: `Seller wallet withdrawal to UPI: ${upiId}${
        fee > 0 ? ` | Processing fee: ₹${fee} (amount < ₹${SELLER_FEE_THRESHOLD})` : ''
      }${requiresAdminApproval ? ' [High-Value Review Queued]' : ''}`,
      paymentGateway: 'system',
      gatewayOrderId: `WDRAW_${user._id.toString().slice(-6)}_${Date.now()}`,
      gatewayPaymentId: `WPAY_${Date.now()}`,
      idempotencyKey,
      balanceBefore,
      balanceAfter,
      status: initialStatus,
      metadata: {
        withdrawalType: 'wallet',
        upiId,
        requestedAmount: requested,
        feeCharged: fee,
        netTransferred: netTransfer,
        feeThreshold: SELLER_FEE_THRESHOLD,
        requiresAdminApproval,
        timestamp: new Date().toISOString()
      }
    });

    if (requiresAdminApproval) {
      console.log(`[FINTECH AUDIT] High-value seller withdrawal (₹${requested}) by ${user._id} queued for review.`);
      try {
        await createNotification(
          user._id,
          'security',
          '🔒 High-Value Withdrawal Security Verification',
          `Your withdrawal request of ₹${requested.toLocaleString('en-IN')} has been received. For amounts exceeding ₹10,000, our banking security protocol performs an automated verification review. Funds will be transferred to ${upiId} shortly.`,
          'payment'
        );
      } catch (_) {}
    }

    console.log(`[Wallet] Seller ${user._id} withdrew ₹${requested} → Net ₹${netTransfer} (fee: ₹${fee}) to UPI: ${upiId} [Status: ${initialStatus}]`);

    res.json({
      success: true,
      requestedAmount: requested,
      feeCharged: fee,
      netTransferred: netTransfer,
      feeApplied: fee > 0,
      feeReason: fee > 0 ? `₹${SELLER_FEE} fee applied because withdrawal was below ₹${SELLER_FEE_THRESHOLD}` : null,
      walletBalance: balanceAfter,
      requiresAdminApproval,
      status: initialStatus,
      transaction,
      message: requiresAdminApproval
        ? `₹${netTransfer.toFixed(2)} withdrawal requested. For amounts over ₹10,000, banking security verification is performed. Transferring to ${upiId} shortly.`
        : (fee > 0
            ? `₹${netTransfer.toFixed(2)} will be transferred to ${upiId} (₹${fee} processing fee deducted).`
            : `₹${netTransfer.toFixed(2)} will be transferred to ${upiId}.`)
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
