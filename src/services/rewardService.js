const User = require('../models/User');
const Reward = require('../models/Reward');
const SystemConfig = require('../models/SystemConfig');
const { createNotification } = require('./notification');
const cashfreeService = require('./cashfreeService');

/**
/**
 * Calculates delivery confirmation cashback amount for buyers:
 * - Standard: Flat ₹2 across all payment methods (COD, Prepaid, Payment Link)
 * - Promotional Campaign: ₹1 to ₹10 when marketing bonus campaign is active
 */
const generateDeliveryCashback = async () => {
  try {
    const config = await SystemConfig.findOne({ configKey: 'GLOBAL_CONFIG' });
    if (config?.cashbackMarketingBonusActive) {
      const min = Number(config?.cashbackMarketingBonusMin) || 1;
      const max = Number(config?.cashbackMarketingBonusMax) || 10;
      const promoAmount = Math.floor(Math.random() * (max - min + 1)) + min;
      return {
        amount: promoAmount,
        tier: 'marketing_bonus',
        isBonus: true
      };
    }
    if (config?.deliveryConfirmCashbackAmount && Number(config.deliveryConfirmCashbackAmount) > 0) {
      return {
        amount: Number(config.deliveryConfirmCashbackAmount),
        tier: 'standard'
      };
    }
  } catch (err) {
    console.warn('[Reward Service] Config lookup fallback:', err.message);
  }

  // Flat ₹2 for buyer on delivery confirmation (default)
  return { amount: 2, tier: 'standard' };
};

/**
 * Calculates weighted random cashback amount between ₹10 and ₹50.
 */
const generateWeightedCashback = () => {
  const rand = Math.random() * 100;
  if (rand < 85) {
    // 85%: ₹3 or ₹4
    const amounts = [3, 4];
    return amounts[Math.floor(Math.random() * amounts.length)];
  } else {
    // 15%: ₹5 or ₹6
    const amounts = [5, 6];
    return amounts[Math.floor(Math.random() * amounts.length)];
  }
};

/**
 * Grants seller/supplier cashback (₹2 to ₹3 in rupees) for a completed / fulfilled shipment.
 * Focuses reward budget on sellers (the core customers) to incentivize booking on SecureKaro.
 */
const grantSellerCashback = async (shipmentId) => {
  try {
    if (!shipmentId) return null;

    const Shipment = require('../models/Shipment');
    const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
    if (!shipment) {
      console.warn(`[Reward Service] Shipment ${shipmentId} not found for seller cashback`);
      return null;
    }

    if (!shipment.senderId) return null;

    // Check if seller cashback was already granted
    const existingReward = await Reward.findOne({
      userId: shipment.senderId,
      shipmentId: shipment.shipmentId,
      category: 'SELLER_SHIPPING_CASHBACK'
    });

    if (existingReward || (shipment.supplierCashbackPaid && shipment.supplierCashbackPaid > 0)) {
      console.log(`[Reward Service] Seller cashback already awarded for shipment ${shipmentId}`);
      return existingReward || { amount: shipment.supplierCashbackPaid };
    }

    // Lookup seller
    const seller = await User.findById(shipment.senderId);
    if (!seller) {
      console.warn(`[Reward Service] Seller ${shipment.senderId} not found`);
      return null;
    }

    // Configurable flat amount in rupees for sellers (default: ₹3 to ₹6)
    let minAmt = 3;
    let maxAmt = 6;
    try {
      const config = await SystemConfig.findOne({ configKey: 'GLOBAL_CONFIG' });
      if (config?.sellerCashbackMin !== undefined) minAmt = Number(config.sellerCashbackMin);
      if (config?.sellerCashbackMax !== undefined) maxAmt = Number(config.sellerCashbackMax);
    } catch (cErr) {
      console.warn('[Reward Service] Config lookup fallback for seller cashback amount:', cErr.message);
    }

    // Determine cashback amount in rupees (e.g. ₹3 to ₹6)
    const pool = [];
    for (let a = Math.round(minAmt); a <= Math.round(maxAmt); a++) {
      pool.push(a);
    }
    const cashbackAmount = pool.length > 0 
      ? pool[Math.floor(Math.random() * pool.length)] 
      : 4;

    // Credit seller cashback balance
    seller.cashbackBalance = parseFloat(((seller.cashbackBalance || 0) + cashbackAmount).toFixed(2));
    seller.totalCashbackEarned = parseFloat(((seller.totalCashbackEarned || 0) + cashbackAmount).toFixed(2));
    await seller.save();

    // Record on shipment model
    shipment.supplierCashbackPaid = cashbackAmount;
    await shipment.save();

    const reward = new Reward({
      userId: seller._id,
      shipmentId: shipment.shipmentId,
      type: 'CASHBACK_EARNED',
      category: 'SELLER_SHIPPING_CASHBACK',
      role: seller.role || 'Supplier',
      amount: cashbackAmount,
      status: 'CREDITED',
      description: `🎉 Seller Shipping Cashback (₹${cashbackAmount}) for completed parcel #${shipment.shipmentId}`
    });
    await reward.save();

    await createNotification(
      seller._id,
      'card_giftcard',
      `🎉 ₹${cashbackAmount} Seller Cashback Earned!`,
      `You earned ₹${cashbackAmount} seller cashback on completed shipment ${shipment.shipmentId}. Added to your SecureKaro wallet!`,
      'payment'
    );

    console.log(`[Reward Service] Granted ₹${cashbackAmount} seller cashback to ${seller.fullName} for ${shipment.shipmentId}`);
    return reward;
  } catch (error) {
    console.error('[Reward Service] Error granting seller cashback:', error);
    return null;
  }
};

/**
 * Grants buyer instant cashback (Fixed ₹5 per Option B) when paying for a shipment via Payment Link.
 * Incentivizes buyers to prepay online, converting risky COD into guaranteed escrow prepaid orders.
 */
const grantPrepaymentCashback = async (shipmentId, receiverIdentifier, options = {}) => {
  try {
    if (!receiverIdentifier || !shipmentId) return null;

    const Shipment = require('../models/Shipment');
    const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });

    if (!shipment) {
      console.warn(`[Reward Service] Shipment ${shipmentId} not found for prepayment cashback.`);
      return null;
    }

    // Check if prepayment cashback already awarded
    const existingReward = await Reward.findOne({
      shipmentId: shipment.shipmentId,
      category: 'PREPAYMENT_REWARD'
    });

    if (existingReward) {
      console.log(`[Reward Service] Prepayment cashback already awarded for ${shipment.shipmentId}`);
      const receiver = await User.findById(existingReward.userId);
      return {
        success: true,
        alreadyAwarded: true,
        amount: existingReward.amount,
        totalCashbackBalance: receiver?.cashbackBalance || existingReward.amount,
        minWithdrawal: 50,
        neededForWithdrawal: Math.max(0, 50 - (receiver?.cashbackBalance || 0))
      };
    }

    // Resolve or provision receiver account
    let receiver = null;
    if (typeof receiverIdentifier === 'object' && receiverIdentifier._id) {
      receiver = await User.findById(receiverIdentifier._id);
    } else if (typeof receiverIdentifier === 'string' && receiverIdentifier.match(/^[0-9a-fA-F]{24}$/)) {
      receiver = await User.findById(receiverIdentifier);
    } else {
      const sanitizedPhone = String(receiverIdentifier).replace(/\D/g, '').slice(-10);
      receiver = await User.findOne({
        $or: [
          { phone: receiverIdentifier },
          { phone: sanitizedPhone },
          { phone: `+91${sanitizedPhone}` }
        ]
      });

      if (!receiver && sanitizedPhone.length === 10) {
        try {
          const guestName = shipment.receiverName || `Buyer ${sanitizedPhone.slice(-4)}`;
          receiver = new User({
            phone: sanitizedPhone,
            fullName: guestName,
            email: `buyer_${sanitizedPhone}_${Date.now()}@securekaro.in`,
            passwordHash: 'GUEST_OTP_VERIFIED',
            role: 'Receiver',
            cashbackBalance: 0,
            totalCashbackEarned: 0
          });
          await receiver.save();
          console.log(`[Reward Service] Provisioned guest receiver profile for payment link buyer: ${sanitizedPhone}`);
        } catch (uErr) {
          console.warn('[Reward Service] Guest receiver note:', uErr.message);
          receiver = await User.findOne({ phone: sanitizedPhone });
        }
      }
    }

    if (!receiver) {
      console.warn(`[Reward Service] Receiver ${receiverIdentifier} could not be resolved for prepayment cashback.`);
      return null;
    }

    // Fixed ₹5 for paying via Payment Link (Option B)
    let cashbackAmount = 5;
    try {
      const config = await SystemConfig.findOne({ configKey: 'GLOBAL_CONFIG' });
      if (config?.paymentLinkCashbackAmount && Number(config.paymentLinkCashbackAmount) > 0) {
        cashbackAmount = Number(config.paymentLinkCashbackAmount);
      }
    } catch (cErr) {
      // Fallback to default ₹5
    }

    receiver.cashbackBalance = parseFloat(((receiver.cashbackBalance || 0) + cashbackAmount).toFixed(2));
    receiver.totalCashbackEarned = parseFloat(((receiver.totalCashbackEarned || 0) + cashbackAmount).toFixed(2));
    await receiver.save();

    const reward = new Reward({
      userId: receiver._id,
      shipmentId: shipment.shipmentId,
      type: 'CASHBACK_EARNED',
      category: 'PREPAYMENT_REWARD',
      role: receiver.role || 'Receiver',
      amount: cashbackAmount,
      status: 'CREDITED',
      description: `🎉 ₹${cashbackAmount} Instant Cashback for paying via Payment Link on #${shipment.shipmentId}`
    });
    await reward.save();

    try {
      await createNotification(
        receiver._id,
        'card_giftcard',
        `🎉 ₹${cashbackAmount} Payment Link Cashback Credited!`,
        `You earned ₹${cashbackAmount} instant cashback for completing payment online via Payment Link for parcel ${shipment.shipmentId}. Your SecureKaro wallet balance is now ₹${receiver.cashbackBalance}.`,
        'payment'
      );
    } catch (notifErr) {
      console.warn('[Reward Service] Notification error:', notifErr.message);
    }

    console.log(`[Reward Service] Granted ₹${cashbackAmount} payment link cashback to ${receiver.fullName || receiver.phone}`);

    const minWithdrawal = 50;
    const neededForWithdrawal = Math.max(0, parseFloat((minWithdrawal - receiver.cashbackBalance).toFixed(2)));

    return {
      success: true,
      amount: cashbackAmount,
      totalCashbackBalance: receiver.cashbackBalance,
      minWithdrawal,
      neededForWithdrawal,
      message: `🎉 ₹${cashbackAmount} instant cashback added to your SecureKaro Wallet for paying online!`
    };
  } catch (error) {
    console.error('[Reward Service] Error granting prepayment cashback:', error);
    return null;
  }
};

/**
 * Grants buyer instant cashback (₹3 - ₹6, up to ₹10 for marketing) when confirming delivery via QR
 * within 24 hours of delivery, without placing a return.
 */
const grantDeliveryConfirmCashback = async (shipmentId, receiverIdentifier, options = {}) => {
  try {
    if (!receiverIdentifier || !shipmentId) return null;

    const Shipment = require('../models/Shipment');
    const shipment = await Shipment.findOne({ shipmentId });

    if (!shipment) {
      console.warn(`[Reward Service] Shipment ${shipmentId} not found.`);
      return null;
    }

    // Check if return was requested or status is return
    if (shipment.returnRequested || ['Return Requested', 'Return In Transit', 'Returned & Refunded'].includes(shipment.status)) {
      console.log(`[Reward Service] No cashback — return requested for shipment ${shipmentId}`);
      return { eligible: false, reason: 'RETURN_REQUESTED', amount: 0 };
    }

    // 24-hour verification window check:
    const deliveryTimestamp = shipment.deliveredAt || shipment.deliveryConfirmedAt || shipment.createdAt;
    if (deliveryTimestamp) {
      const hoursSinceDelivery = (Date.now() - new Date(deliveryTimestamp).getTime()) / (1000 * 60 * 60);
      if (hoursSinceDelivery > 24) {
        console.log(`[Reward Service] 24-hour window expired (${hoursSinceDelivery.toFixed(1)} hrs elapsed) for ${shipmentId}`);
        return { eligible: false, reason: 'EXPIRED_24H', amount: 0 };
      }
    }

    // Prevent duplicate delivery confirmation cashback
    const existingReward = await Reward.findOne({
      shipmentId,
      category: 'DELIVERY_CONFIRMATION_REWARD'
    });

    if (existingReward) {
      console.log(`[Reward Service] Delivery confirmation cashback already awarded for ${shipmentId}`);
      const receiver = await User.findById(existingReward.userId);
      return {
        alreadyAwarded: true,
        amount: existingReward.amount,
        tier: existingReward.amount >= 5 ? 'lucky' : 'standard',
        totalCashbackBalance: receiver?.cashbackBalance || existingReward.amount,
        minWithdrawal: 50,
        neededForWithdrawal: Math.max(0, 50 - (receiver?.cashbackBalance || 0))
      };
    }

    // Find or automatically create receiver account
    let receiver = null;
    if (typeof receiverIdentifier === 'object' && receiverIdentifier._id) {
      receiver = await User.findById(receiverIdentifier._id);
    } else if (typeof receiverIdentifier === 'string' && receiverIdentifier.match(/^[0-9a-fA-F]{24}$/)) {
      receiver = await User.findById(receiverIdentifier);
    } else {
      const sanitizedPhone = String(receiverIdentifier).replace(/\D/g, '').slice(-10);
      receiver = await User.findOne({
        $or: [
          { phone: receiverIdentifier },
          { phone: sanitizedPhone },
          { phone: `+91${sanitizedPhone}` }
        ]
      });

      if (!receiver && sanitizedPhone.length === 10) {
        try {
          const guestName = shipment.receiverName || `Buyer ${sanitizedPhone.slice(-4)}`;
          receiver = new User({
            phone: sanitizedPhone,
            fullName: guestName,
            email: `buyer_${sanitizedPhone}_${Date.now()}@securekaro.in`,
            passwordHash: 'GUEST_OTP_VERIFIED',
            role: 'Receiver',
            cashbackBalance: 0,
            totalCashbackEarned: 0
          });
          await receiver.save();
          console.log(`[Reward Service] Provisioned guest receiver profile for ${sanitizedPhone}`);
        } catch (uErr) {
          console.warn('[Reward Service] Guest receiver profile note:', uErr.message);
          receiver = await User.findOne({ phone: sanitizedPhone });
        }
      }
    }

    if (!receiver) {
      console.log(`[Reward Service] Receiver ${receiverIdentifier} could not be resolved.`);
      return null;
    }

    const { amount: cashbackAmount, tier } = await generateDeliveryCashback();

    receiver.cashbackBalance = parseFloat(((receiver.cashbackBalance || 0) + cashbackAmount).toFixed(2));
    receiver.totalCashbackEarned = parseFloat(((receiver.totalCashbackEarned || 0) + cashbackAmount).toFixed(2));
    await receiver.save();

    const reward = new Reward({
      userId: receiver._id,
      shipmentId,
      type: 'CASHBACK_EARNED',
      category: 'DELIVERY_CONFIRMATION_REWARD',
      role: receiver.role || 'Receiver',
      amount: cashbackAmount,
      status: 'CREDITED',
      description: `Instant Parcel Delivery Confirmation Cashback for #${shipmentId}`
    });
    await reward.save();

    try {
      await createNotification(
        receiver._id,
        'card_giftcard',
        `🎉 ₹${cashbackAmount} Instant Cashback Credited!`,
        `You earned ₹${cashbackAmount} for instantly confirming delivery of parcel ${shipmentId} without returns. Your wallet balance is now ₹${receiver.cashbackBalance}.`,
        'payment'
      );
    } catch (notifErr) {
      console.warn('[Reward Service] Notification error:', notifErr.message);
    }

    console.log(`[Reward Service] Granted ₹${cashbackAmount} delivery confirmation cashback to ${receiver.fullName || receiver.phone} (${tier})`);

    const minWithdrawal = 50;
    const neededForWithdrawal = Math.max(0, parseFloat((minWithdrawal - receiver.cashbackBalance).toFixed(2)));

    return {
      success: true,
      amount: cashbackAmount,
      tier,
      isLucky: tier === 'lucky',
      isBonus: tier === 'marketing_bonus',
      totalCashbackBalance: receiver.cashbackBalance,
      minWithdrawal,
      neededForWithdrawal,
      message: `🎉 ₹${cashbackAmount} instant cashback added to your SecureKaro Wallet!`
    };
  } catch (error) {
    console.error('[Reward Service] Error granting delivery confirm cashback:', error);
    return null;
  }
};

/**
 * Computes the complete Supplier Wallet balances:
 * Includes parcel values & cashbacks for shipments where tracking ID is submitted and receiver payment is done.
 * Evaluates the 24-hour buyer confirmation window (automatically closes in 24 hours).
 */
const computeSupplierWallet = async (userId) => {
  const user = await User.findById(userId);
  if (!user) return null;

  const Shipment = require('../models/Shipment');
  const Reward = require('../models/Reward');

  const shipments = await Shipment.find({ senderId: userId });
  const rewards = await Reward.find({ userId }).sort({ createdAt: -1 });

  let withdrawableParcelAmount = 0;
  let withdrawableCashbackAmount = 0;
  let pendingConfirmationParcelAmount = 0;
  let pendingConfirmationCashbackAmount = 0;
  const confirmationPipeline = [];

  for (const s of shipments) {
    const isPaymentDone = s.receiverPaymentDone || s.escrowStage >= 2 || (s.status !== 'Awaiting Payment' && s.status !== 'Cancelled');
    const isTrackingSubmitted = s.trackingSubmitted || (s.awbCode && s.awbCode.trim() !== '');

    if (isPaymentDone && isTrackingSubmitted) {
      // ₹3 to ₹6 seller cashback calculation in rupees
      const cbAmt = s.supplierCashbackPaid > 0 
        ? s.supplierCashbackPaid 
        : 4; // flat ₹4 (in ₹3 – ₹6 range)

      const baseDate = s.trackingSubmittedAt || s.receiverPaidAt || s.createdAt || new Date();
      const expiresAt = s.confirmationWindowExpiresAt || new Date(new Date(baseDate).getTime() + 24 * 60 * 60 * 1000);
      const isWindowClosed = s.confirmationWindowClosed || s.status === 'Released' || Date.now() >= new Date(expiresAt).getTime();

      if (isWindowClosed) {
        if (!s.confirmationWindowClosed) {
          s.confirmationWindowClosed = true;
          s.withdrawableAt = s.withdrawableAt || expiresAt;
          await s.save();
        }
        withdrawableParcelAmount += (s.amount || 0);
        withdrawableCashbackAmount += cbAmt;
      } else {
        pendingConfirmationParcelAmount += (s.amount || 0);
        pendingConfirmationCashbackAmount += cbAmt;
        const remainingMs = Math.max(0, new Date(expiresAt).getTime() - Date.now());
        confirmationPipeline.push({
          shipmentId: s.shipmentId,
          parcelAmount: s.amount || 0,
          cashbackAmount: cbAmt,
          cashbackRate: '₹3 – ₹6',
          totalAmount: (s.amount || 0) + cbAmt,
          awbCode: s.awbCode,
          carrierSlug: s.carrierSlug || 'delhivery',
          status: s.status,
          confirmationWindowExpiresAt: expiresAt,
          timeRemainingMs: remainingMs,
          hoursRemaining: Math.ceil(remainingMs / (1000 * 60 * 60))
        });
      }
    }
  }

  // Standalone cashback rewards
  const otherRewards = rewards
    .filter(r => (!shipments.some(s => s.shipmentId === r.shipmentId) && r.type === 'CASHBACK_EARNED'))
    .reduce((sum, r) => sum + (r.amount || 0), 0);

  const directWalletCredits = parseFloat((Number(user.walletBalance) || 0).toFixed(2));
  const totalEarnedWithdrawable = withdrawableParcelAmount + withdrawableCashbackAmount + otherRewards;
  const withdrawableBalance = Math.max(0, parseFloat((totalEarnedWithdrawable + directWalletCredits - (user.totalWithdrawn || 0)).toFixed(2)));
  const pendingConfirmationBalance = parseFloat((pendingConfirmationParcelAmount + pendingConfirmationCashbackAmount).toFixed(2));
  const totalWalletBalance = parseFloat((withdrawableBalance + pendingConfirmationBalance).toFixed(2));

  return {
    withdrawableBalance,
    pendingConfirmationBalance,
    pendingConfirmationParcelAmount,
    pendingConfirmationCashbackAmount,
    withdrawableParcelAmount,
    withdrawableCashbackAmount,
    directWalletCredits,
    totalWalletBalance,
    totalWithdrawn: user.totalWithdrawn || 0,
    confirmationPipeline
  };
};

/**
 * Processes cashback / escrow reward withdrawal to Bank Account or UPI ID.
 * Available for both Suppliers and Receivers.
 * 
 * Rules:
 * - Buyers/Receivers: Must use Mobile App and minimum withdrawal is ₹50
 * - Suppliers: Can withdraw available parcel settlements via Bank or UPI
 */
const withdrawCashback = async (userId, amount, method, payoutDetails, isMobileApp = false) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const withdrawAmount = Number(amount);
  if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
    throw new Error('Please enter a valid withdrawal amount greater than ₹0');
  }

  const isSupplier = user.role === 'Supplier';
  const directWalletCredits = parseFloat((Number(user.walletBalance) || 0).toFixed(2));
  let availableBalance = (user.cashbackBalance || 0) + directWalletCredits;

  if (isSupplier) {
    const supplierWallet = await computeSupplierWallet(userId);
    if (supplierWallet) {
      availableBalance = supplierWallet.withdrawableBalance;
      if (withdrawAmount > availableBalance) {
        throw new Error(`Requested amount (₹${withdrawAmount}) exceeds your available withdrawable balance of ₹${availableBalance}. ₹${supplierWallet.pendingConfirmationBalance} is currently locked in the 24-hour buyer confirmation window and will become withdrawable automatically once the window closes.`);
      }
    }
  } else {
    // Non-supplier (Buyer / Receiver):
    // Rule 1: Must be using the mobile app
    if (!isMobileApp) {
      throw new Error('APP_DOWNLOAD_REQUIRED: Cashback withdrawals can only be processed through the SecureKaro Mobile App. Please download the app to transfer your wallet balance to your UPI account.');
    }
    // Rule 2: Minimum withdrawal is ₹50
    const MIN_WITHDRAWAL = 50;
    if (withdrawAmount < MIN_WITHDRAWAL) {
      throw new Error(`Minimum withdrawal amount is ₹${MIN_WITHDRAWAL}. Your current available balance is ₹${availableBalance}.`);
    }
    if (availableBalance < withdrawAmount) {
      throw new Error(`Insufficient balance. Available: ₹${availableBalance}`);
    }
  }

  if (method === 'UPI' && (!payoutDetails?.upiId || !payoutDetails.upiId.includes('@'))) {
    throw new Error('Please provide a valid UPI ID (e.g. user@upi)');
  }

  if (method === 'BANK' && (!payoutDetails?.accountNumber || !payoutDetails?.ifscCode || !payoutDetails?.accountHolderName)) {
    throw new Error('Please provide complete bank account details (Account Number, IFSC Code, Account Holder Name)');
  }

  // Deduct from walletBalance first (direct credits), then cashbackBalance
  let remainingDeduction = withdrawAmount;
  const walletDeduction = Math.min(directWalletCredits, remainingDeduction);
  remainingDeduction -= walletDeduction;
  const cashbackDeduction = Math.min(user.cashbackBalance || 0, remainingDeduction);

  user.walletBalance = parseFloat(Math.max(0, directWalletCredits - walletDeduction).toFixed(2));
  user.cashbackBalance = parseFloat(Math.max(0, (user.cashbackBalance || 0) - cashbackDeduction).toFixed(2));
  user.totalWithdrawn = (user.totalWithdrawn || 0) + withdrawAmount;

  if (method === 'UPI' && payoutDetails?.upiId) {
    if (!user.bankDetails) user.bankDetails = {};
    user.bankDetails.upiId = payoutDetails.upiId;
  } else if (method === 'BANK') {
    if (!user.bankDetails) user.bankDetails = {};
    user.bankDetails.accountHolderName = payoutDetails.accountHolderName;
    user.bankDetails.accountNumber = payoutDetails.accountNumber;
    user.bankDetails.ifscCode = payoutDetails.ifscCode;
    if (payoutDetails.bankName) user.bankDetails.bankName = payoutDetails.bankName;
  }

  await user.save();

  const withdrawalRecord = new Reward({
    userId: user._id,
    type: 'WITHDRAWAL',
    category: 'WITHDRAWAL',
    role: user.role || 'User',
    amount: withdrawAmount,
    status: 'WITHDRAWN',
    payoutMethod: method,
    payoutDetails: {
      accountHolderName: payoutDetails?.accountHolderName || user.bankDetails?.accountHolderName || '',
      accountNumber: payoutDetails?.accountNumber || user.bankDetails?.accountNumber || '',
      ifscCode: payoutDetails?.ifscCode || user.bankDetails?.ifscCode || '',
      bankName: payoutDetails?.bankName || user.bankDetails?.bankName || '',
      upiId: payoutDetails?.upiId || user.bankDetails?.upiId || ''
    },
    description: method === 'UPI'
      ? `Cash withdrawal to UPI ID: ${payoutDetails.upiId}`
      : `Cash withdrawal to Bank A/C ending in ...${(payoutDetails.accountNumber || '').slice(-4)}`
  });

  await withdrawalRecord.save();

  // Trigger Cashfree Instant IMPS/UPI Payout
  let payoutRes = null;
  try {
    const transferMode = method === 'UPI' ? 'UPI' : 'IMPS';
    payoutRes = await cashfreeService.requestPayout({
      beneficiary_id: user.cashfreeBeneficiaryId || `BEN_${user._id.toString()}`,
      amount: withdrawAmount,
      transfer_mode: transferMode, // IMPS (30–60 mins 24/7) or UPI (<5 mins)
      remarks: `SecureKaro Withdrawal - ${user.fullName}`,
      beneficiary_details: {
        account_number: user.bankDetails?.accountNumber || payoutDetails?.accountNumber || '',
        ifsc: user.bankDetails?.ifscCode || payoutDetails?.ifscCode || '',
        upi_id: user.bankDetails?.upiId || payoutDetails?.upiId || '',
        name: user.bankDetails?.accountHolderName || user.fullName
      }
    });
    if (payoutRes?.transferId) {
      withdrawalRecord.transferId = payoutRes.transferId;
      withdrawalRecord.transferMode = payoutRes.transferMode;
      await withdrawalRecord.save();
    }
  } catch (err) {
    console.warn('[Reward Withdrawal Payout] Non-blocking Cashfree payout notice:', err.message);
  }

  const destText = method === 'UPI'
    ? `UPI ID ${payoutDetails.upiId}`
    : `Bank Account ending in ...${(payoutDetails.accountNumber || '').slice(-4)}`;

  const speedText = method === 'UPI' ? 'near-instant UPI (<5 mins)' : 'fast 24/7 IMPS (30–60 mins)';
  const remainingTotal = parseFloat(((user.cashbackBalance || 0) + (user.walletBalance || 0)).toFixed(2));
  await createNotification(
    user._id,
    'payments',
    `💸 ₹${withdrawAmount} Withdrawn Successfully`,
    `Transferred ₹${withdrawAmount} to your ${destText} via ${speedText}. Remaining balance: ₹${remainingTotal}.`,
    'payment'
  );

  return {
    user,
    cashbackBalance: user.cashbackBalance,
    walletBalance: user.walletBalance,
    withdrawal: withdrawalRecord
  };
};

module.exports = {
  generateWeightedCashback,
  generateDeliveryCashback,
  grantPrepaymentCashback,
  grantDeliveryConfirmCashback,
  grantSellerCashback,
  computeSupplierWallet,
  withdrawCashback
};
