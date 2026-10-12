const Shipment = require('../models/Shipment');
const User = require('../models/User');
const Reward = require('../models/Reward');
const WalletTransaction = require('../models/WalletTransaction');
const { createNotification } = require('./notification');
const { calculateServiceFee } = require('../utils/feeConfig');
const cashfreeService = require('./cashfreeService');

/**
 * Helper: Find receiver user by exact or normalized phone number
 */
const findReceiverUser = async (shipment, receiverId = null) => {
  if (receiverId) {
    const user = await User.findById(receiverId);
    if (user) return user;
  }
  if (!shipment || !shipment.receiverPhone) return null;
  let receiver = await User.findOne({ phone: shipment.receiverPhone });
  if (!receiver) {
    const sanitized = shipment.receiverPhone.replace(/\D/g, '').slice(-10);
    if (sanitized) {
      receiver = await User.findOne({
        $or: [
          { phone: sanitized },
          { phone: `+91${sanitized}` }
        ]
      });
    }
  }
  return receiver;
};

/**
 * Handles release of escrowed funds.
 * Releases 100% principal amount to the Supplier upon return window completion.
 */
const releaseEscrow = async (shipmentId, receiverId) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  
  if (!shipment) {
    throw new Error('Shipment not found');
  }

  // Validate shipment state
  if (shipment.escrowStage === 6) {
    throw new Error('Escrow funds have already been released');
  }

  if (shipment.escrowStage === -1) {
    throw new Error('Escrow is locked due to an active dispute claim');
  }

  // Calculate days held
  const createdDate = shipment.createdAt ? new Date(shipment.createdAt) : new Date();
  const daysHeld = Math.max(1, Math.ceil((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));
  const accruedInterest = 0; // No interest system

  // Platform service fee = 0 (SecureKaro escrow is free for all users)
  const feeCalc = calculateServiceFee(shipment.amount);
  const serviceFee = feeCalc.fee; // Always 0

  // ── Multi-Mode Courier Delivery Charge Calculation ─────────────────────────
  // Mode A: Online / Prepaid Escrow: Courier fee auto-deducted from escrow settlement
  // Mode B: COD (Cash on Delivery): Courier freight + COD handling fee auto-deducted from COD remittance
  // Mode C: Paid Offline: Courier freight debited from seller wallet
  const hasCourierBooked = Boolean(shipment.carrierSlug || shipment.awbCode || (shipment.pickupRate && shipment.pickupRate > 0));
  const courierFreight = shipment.courierDeliveryCharge > 0 
    ? shipment.courierDeliveryCharge 
    : (shipment.pickupRate > 0 ? shipment.pickupRate : (hasCourierBooked ? 55 : 0));

  const isCod = shipment.paymentMode === 'cod';
  const codHandlingFee = isCod ? (shipment.codHandlingCharge > 0 ? shipment.codHandlingCharge : 30) : 0;
  const isPaidOffline = shipment.paymentMode === 'paid_offline';

  // In online/escrow and COD modes, courier & COD fees are net-settled from escrow
  const freightDeduction = isPaidOffline ? 0 : courierFreight;
  const totalDeductions = parseFloat((serviceFee + freightDeduction + codHandlingFee).toFixed(2));
  const netPayout = Math.max(0, parseFloat((shipment.amount - totalDeductions).toFixed(2)));

  // Release the escrow funds (deduct courier freight & COD handling — no platform fee)
  shipment.status = 'Released';
  shipment.escrowStage = 6;
  shipment.daysInEscrow = daysHeld;
  shipment.gatewayFeeDeducted = serviceFee;
  shipment.gatewayFeeRate = feeCalc.rate;
  shipment.serviceFeeDeducted = serviceFee;
  shipment.serviceFeeRate = feeCalc.rate;
  shipment.courierDeliveryCharge = courierFreight;
  shipment.codHandlingCharge = codHandlingFee;
  shipment.courierChargeDeducted = freightDeduction + codHandlingFee;
  shipment.courierChargeDeductedFrom = isPaidOffline ? 'seller_wallet' : (isCod ? 'cod_remittance' : 'escrow_settlement');
  shipment.courierChargeStatus = 'Deducted';
  shipment.netSellerPayout = netPayout;
  shipment.isOverMonthlyThreshold = false;
  shipment.principalDisbursedToSupplier = netPayout;
  shipment.confirmationWindowClosed = true;
  shipment.withdrawableAt = new Date();
  await shipment.save();

  // Find sender and receiver user profiles
  const sender = await User.findById(shipment.senderId);
  const receiver = await findReceiverUser(shipment, receiverId);

  // Credit sender wallet balance if online escrow mode
  if (!isPaidOffline && sender) {
    const balBefore = Number(sender.walletBalance) || 0;
    sender.walletBalance = parseFloat((balBefore + netPayout).toFixed(2));
    await sender.save();
    try {
      const { recordTransaction } = require('./walletService');
      await recordTransaction({
        userId: sender._id,
        type: 'credit',
        amount: netPayout,
        source: 'escrow_settlement',
        description: `Escrow payout released for shipment ${shipment.shipmentId}`,
        balanceBefore: balBefore,
        balanceAfter: sender.walletBalance,
        metadata: { shipmentId: shipment.shipmentId }
      });
    } catch (e) {}
  }

  // ── Cashfree Fast Escrow Payout (IMPS / UPI) ──────────────────────────────
  // IMPS ensures 30–60 min settlement (24/7) vs 1–2 day NEFT batch processing
  let payoutResult = null;
  if (!isPaidOffline && sender && netPayout > 0) {
    const hasUpi = Boolean(sender.bankDetails?.upiId);
    // UPI for amounts <= ₹1L if UPI ID configured, otherwise IMPS (up to ₹5L limit)
    const selectedMode = (hasUpi && netPayout <= 100000) ? 'UPI' : 'IMPS';

    const payoutPayload = {
      beneficiary_id: sender.cashfreeBeneficiaryId || `BEN_${sender._id.toString()}`,
      amount: netPayout,
      transfer_mode: selectedMode, // IMPS ensures 30-60 min settlement (24/7) vs 1-2 day NEFT batch processing
      remarks: `SecureKaro Escrow Release - Order ${shipment.shipmentId}`,
      beneficiary_details: {
        account_number: sender.bankDetails?.accountNumber || '',
        ifsc: sender.bankDetails?.ifscCode || '',
        upi_id: sender.bankDetails?.upiId || '',
        name: sender.bankDetails?.accountHolderName || sender.fullName
      }
    };

    try {
      payoutResult = await cashfreeService.requestPayout(payoutPayload);
      shipment.payoutTransferMode = payoutPayload.transfer_mode;
      shipment.payoutTransferId = payoutResult.transferId;
      shipment.payoutStatus = payoutResult.status;
      await shipment.save();
    } catch (payoutErr) {
      console.warn(`[Escrow Payout] Non-blocking Cashfree payout trigger notice:`, payoutErr.message);
    }
  }

  // Generate payment summary details
  const formattedAmount = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;
  const formattedNet = `₹${new Intl.NumberFormat('en-IN').format(netPayout)}`;
  const formattedFee = `₹${new Intl.NumberFormat('en-IN').format(serviceFee)}`;

  // Create notifications
  if (sender) {
    // Notify sender that funds are payout-cleared minus courier freight & COD handling only
    const formattedCourier = courierFreight > 0 ? `, Courier Freight: -₹${courierFreight}` : '';
    const formattedCod = codHandlingFee > 0 ? `, COD Handling: -₹${codHandlingFee}` : '';
    let payoutMsg = `Payment of ${formattedNet} for shipment ${shipment.shipmentId} has been released to your wallet (Gross: ${formattedAmount}${formattedCourier}${formattedCod}). Escrow service is FREE — no platform fee deducted.`;
    
    if (sender.bankDetails && sender.bankDetails.accountNumber) {
      payoutMsg += ` Funds ready for withdrawal to A/C ending in ...${sender.bankDetails.accountNumber.slice(-4)} via 24/7 IMPS (30–60 min settlement).`;
    } else if (sender.bankDetails && sender.bankDetails.upiId) {
      payoutMsg += ` Funds ready for withdrawal to UPI ID ${sender.bankDetails.upiId} (near-instant settlement).`;
    } else {
      payoutMsg += ` Add bank payout details to your profile to withdraw via 24/7 IMPS.`;
    }
    
    await createNotification(
      sender._id,
      'payments',
      `Escrow Payout Released — ${shipment.shipmentId}`,
      payoutMsg,
      'payment'
    );
  }

  if (receiver) {
    await createNotification(
      receiver._id,
      'verified',
      `Escrow Settled — ${shipment.shipmentId}`,
      `Parcel ${shipment.shipmentId} return period concluded. Principal (${formattedAmount}) disbursed to supplier.`,
      'confirmed'
    );
  }

  // \u2500\u2500 Refer & Earn: Credit referrer \u20b940 on referred seller's FIRST delivery \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (sender && sender.referredBy) {
    try {
      // Count shipments this seller has previously had released (excluding this one)
      const prevReleasedCount = await Shipment.countDocuments({
        senderId: sender._id,
        status: 'Released',
        _id: { $ne: shipment._id }
      });

      if (prevReleasedCount === 0) {
        // This is the referred seller's FIRST ever delivered & released shipment
        const referrer = await User.findById(sender.referredBy);
        if (referrer) {
          const REFERRAL_REWARD = 40;
          const balBefore = Number(referrer.walletBalance) || 0;
          const balAfter = parseFloat((balBefore + REFERRAL_REWARD).toFixed(2));
          referrer.walletBalance = balAfter;
          referrer.referralCredits = parseFloat(((Number(referrer.referralCredits) || 0) + REFERRAL_REWARD).toFixed(2));
          referrer.totalReferralEarned = parseFloat(((Number(referrer.totalReferralEarned) || 0) + REFERRAL_REWARD).toFixed(2));
          await referrer.save();

          try {
            await WalletTransaction.create({
              userId: referrer._id,
              type: 'CREDIT',
              source: 'referral_reward',
              amount: REFERRAL_REWARD,
              balanceBefore: balBefore,
              balanceAfter: balAfter,
              description: `Referral Cash Reward: ${sender.fullName || 'Friend'} completed first shipment delivery`,
              referenceId: shipment.shipmentId
            });
          } catch (txErr) {
            console.warn('[REFERRAL] WalletTransaction log error:', txErr.message);
          }

          await createNotification(
            referrer._id,
            'stars',
            `🎉 Refer & Earn: +₹40 Cash Added to Wallet!`,
            `${sender.fullName} (your referral) just completed their first shipment delivery! ` +
            `₹40 cash has been credited directly to your Wallet. You can withdraw it to UPI/Bank or use it to pay for courier shipments.`,
            'reward'
          );

          console.log(`[REFERRAL] ₹40 cash reward added to wallet for ${referrer.fullName} (referred: ${sender.fullName}, shipment: ${shipment.shipmentId})`);
        }
      }
    } catch (refErr) {
      console.warn('[REFERRAL] Credit grant failed (non-fatal):', refErr.message);
    }
  }

  return {
    shipment,
    settlement: {
      principalToSupplier: shipment.amount,
      daysHeld
    }
  };
};

/**
 * Locks escrow funds (due to disputes).
 */
const lockEscrow = async (shipmentId, claimUser) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  
  if (!shipment) {
    throw new Error('Shipment not found');
  }

  shipment.status = 'Locked';
  shipment.escrowStage = -1;
  await shipment.save();

  // Notify sender
  const formattedAmount = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;
  await createNotification(
    shipment.senderId,
    'gavel',
    `Dispute Claim Filed: ${shipment.shipmentId}`,
    `The receiver has locked the escrow of ${formattedAmount} and filed a claim. Funds are frozen until resolution.`,
    'alert'
  );

  return shipment;
};

/**
 * Cancels shipment and handles escrow refund if applicable.
 */
const cancelEscrow = async (shipmentId, userId, reason = 'Cancelled by user') => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  
  if (!shipment) {
    throw new Error('Shipment not found');
  }

  if (shipment.status === 'Cancelled') {
    throw new Error('Shipment is already cancelled');
  }

  if (shipment.status === 'Released') {
    throw new Error('Cannot cancel a shipment whose escrow funds have already been released');
  }

  if (['In Transit', 'Reached Destination Hub', 'Out for Delivery', 'Delivered'].includes(shipment.status)) {
    throw new Error('Cannot cancel shipment once package is in transit with the carrier partner. Please file a dispute claim instead.');
  }

  const wasFunded = shipment.escrowStage >= 2;

  shipment.status = 'Cancelled';
  shipment.escrowStage = -2;
  if (wasFunded) {
    shipment.principalRefundedToReceiver = shipment.amount;
  }
  await shipment.save();

  const formattedAmount = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;

  // Notify Sender
  await createNotification(
    shipment.senderId,
    'cancel',
    `Shipment Cancelled: ${shipment.shipmentId}`,
    `Order ${shipment.shipmentId} was cancelled. ${wasFunded ? `Escrow deposit of ${formattedAmount} refunded.` : ''} Reason: ${reason}`,
    'alert'
  );

  // Find Receiver and credit wallet if funded
  const receiver = await findReceiverUser(shipment, userId);
  if (receiver && wasFunded) {
    const refundAmt = Number(shipment.amount) || 0;
    const balBefore = Number(receiver.walletBalance) || 0;
    receiver.walletBalance = parseFloat((balBefore + refundAmt).toFixed(2));
    await receiver.save();
    try {
      const { recordTransaction } = require('./walletService');
      await recordTransaction({
        userId: receiver._id,
        type: 'credit',
        amount: refundAmt,
        source: 'refund',
        description: `Escrow refund credited for cancelled shipment ${shipment.shipmentId}`,
        balanceBefore: balBefore,
        balanceAfter: receiver.walletBalance,
        metadata: { shipmentId: shipment.shipmentId }
      });
    } catch (e) {}
  }
  if (receiver) {
    await createNotification(
      receiver._id,
      'cancel',
      `Shipment Cancelled: ${shipment.shipmentId}`,
      `Escrow order ${shipment.shipmentId} (${formattedAmount}) was cancelled.${wasFunded ? ` Full refund of ${formattedAmount} credited to your wallet.` : ''} Reason: ${reason}`,
      'alert'
    );
  }

  return shipment;
};

/**
 * Refunds escrow principal to Receiver for undelivered courier shipments.
 * Zero penalties / deductions applied (100% principal refunded to receiver).
 */
const refundUndeliveredEscrow = async (shipmentId, reason = 'Carrier reported delivery failed / undelivered') => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  
  if (!shipment) {
    throw new Error('Shipment not found');
  }

  if (shipment.status === 'Undelivered') {
    throw new Error('Shipment has already been processed as undelivered and refunded');
  }

  if (shipment.status === 'Released') {
    throw new Error('Cannot process undelivered refund for a shipment whose funds were already released');
  }

  // ── Smart RTO & Undelivered Protection Calculation ────────────────────────
  const principal = Number(shipment.amount) || 0;
  // If payment mode is COD or paid_offline, receiver never paid platform escrow before delivery
  const isCod = shipment.paymentMode === 'cod';
  const isPaidOffline = shipment.paymentMode === 'paid_offline';
  const isOnlineEscrow = !isCod && !isPaidOffline;

  // Relief paid BY SecureKaro TO the seller (1st/2nd buyer rejection) — sellers are never charged
  let supplierRelief = 0;
  // Share of buyer's fair-play fee that goes to seller's wallet (3rd+ buyer rejection)
  let supplierBuyerPenaltyShare = 0;
  // Buyer fair-play fee (only on 3rd+ rejection in a week under RTO Protection)
  let receiverPenalty = 0;
  let receiverRefund = isOnlineEscrow ? principal : 0;
  // Weekly buyer rejection count (for RTO Protection threshold check)
  let receiverWeeklyRejectionCount = 0;

  // Evaluate Smart RTO Protection if enabled on this shipment
  if (shipment.rtoProtectionEnabled === true) {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Track buyer's rejection count in past 7 days (excluding this shipment)
    receiverWeeklyRejectionCount = await Shipment.countDocuments({
      receiverPhone: shipment.receiverPhone,
      status: 'Undelivered',
      undeliveredProcessedAt: { $gte: oneWeekAgo },
      _id: { $ne: shipment._id }
    });

    if (receiverWeeklyRejectionCount < 2) {
      // Buyer's 1st or 2nd rejection this week:
      // → Buyer gets 100% full refund (no penalty)
      // → SecureKaro compensates seller ₹40 as burden relief
      receiverPenalty = 0;
      receiverRefund = isOnlineEscrow ? principal : 0;
      supplierRelief = 40;
      supplierBuyerPenaltyShare = 0;
    } else {
      // Buyer's 3rd+ rejection this week:
      // → Buyer is charged ₹40 (₹30 goes to seller, ₹10 kept by SecureKaro)
      receiverPenalty = 40;
      receiverRefund = isOnlineEscrow ? Math.max(0, parseFloat((principal - receiverPenalty).toFixed(2))) : 0;
      supplierRelief = 0;
      supplierBuyerPenaltyShare = 30; // ₹30 of buyer's ₹40 penalty goes to seller
    }
  }

  // Calculate days held
  const createdDate = shipment.createdAt ? new Date(shipment.createdAt) : new Date();
  const daysHeld = Math.max(1, Math.ceil((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));

  // Persist undelivered status on the shipment record
  shipment.status = 'Undelivered';
  shipment.escrowStage = -3;
  shipment.daysInEscrow = daysHeld;
  shipment.undeliveredSupplierRelief = supplierRelief + supplierBuyerPenaltyShare;
  shipment.undeliveredSupplierPenalty = 0; // Sellers are NEVER penalized — SecureKaro policy
  shipment.undeliveredSupplierCharge = 0;  // No charge to seller, ever
  shipment.undeliveredReceiverPenalty = receiverPenalty;
  shipment.undeliveredPlatformCharge = receiverPenalty > 0 ? 10 : 0; // SecureKaro keeps ₹10 of the ₹40 buyer penalty
  shipment.principalRefundedToReceiver = receiverRefund;
  shipment.undeliveredReason = reason;
  shipment.undeliveredProcessedAt = new Date();
  await shipment.save();

  // ── Format helpers ─────────────────────────────────────────────────────────
  const fmt = (n) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;
  const formattedPrincipal = fmt(principal);

  // ── Credit receiver's wallet (after penalty deduction if applicable) ───────
  const receiver = await findReceiverUser(shipment);
  if (receiver) {
    if (receiverRefund > 0) {
      const balBefore = Number(receiver.walletBalance) || 0;
      receiver.walletBalance = parseFloat((balBefore + receiverRefund).toFixed(2));
      await receiver.save();
      try {
        const { recordTransaction } = require('./walletService');
        await recordTransaction({
          userId: receiver._id,
          type: 'credit',
          amount: receiverRefund,
          source: 'refund',
          description: `Undelivered parcel refund credited for ${shipment.shipmentId}`,
          balanceBefore: balBefore,
          balanceAfter: receiver.walletBalance,
          metadata: { shipmentId: shipment.shipmentId }
        });
      } catch (e) {}
    }

    if (receiverPenalty > 0) {
      // 3rd+ rejection: buyer charged ₹40, ₹30 to seller, ₹10 to SecureKaro
      await createNotification(
        receiver._id,
        'payments',
        `Delivery Rejected — Fair-Play Fee Charged: ${shipment.shipmentId}`,
        `Shipment ${shipment.shipmentId} was rejected/undelivered (${reason}). ` +
        `You have exceeded the 2 free rejections allowed per week under RTO Protection rules. ` +
        `A fair-play charge of ${fmt(receiverPenalty)} has been deducted (₹30 compensates the seller, ₹10 goes to SecureKaro). ` +
        `Net refund of ${fmt(receiverRefund)} has been credited to your wallet.`,
        'payment'
      );
    } else {
      // 1st or 2nd rejection: full refund with a gentle warning
      const warnMsg = shipment.rtoProtectionEnabled
        ? ` ⚠️ Note: If you reject more than 2 parcels in a week, a ₹40 fair-play fee will be charged from your next rejection.`
        : '';
      await createNotification(
        receiver._id,
        'payments',
        `Delivery Failed — Full Refund Processed: ${shipment.shipmentId}`,
        `Shipment ${shipment.shipmentId} was undelivered (${reason}). ` +
        `100% of your escrow principal (${formattedPrincipal}) has been refunded to your wallet with zero deduction.${warnMsg}`,
        'payment'
      );
    }
  }

  // ── Handle supplier wallet & notifications ─────────────────────────────────
  const supplier = await User.findById(shipment.senderId);
  if (supplier) {
    const totalSupplierCredit = supplierRelief + supplierBuyerPenaltyShare;

    if (totalSupplierCredit > 0) {
      // Credit seller wallet: either ₹40 SecureKaro relief (1st/2nd buyer rejection)
      // OR ₹30 from buyer's penalty (3rd+ buyer rejection)
      supplier.walletBalance = parseFloat(((Number(supplier.walletBalance) || 0) + totalSupplierCredit).toFixed(2));
      await supplier.save();

      if (supplierRelief > 0) {
        // SecureKaro compensation: buyer's 1st or 2nd rejection this week
        await createNotification(
          supplier._id,
          'local_shipping',
          `RTO Protection: +${fmt(supplierRelief)} SecureKaro Compensation`,
          `Shipment ${shipment.shipmentId} was rejected/undelivered by the buyer (${reason}). ` +
          `Under RTO & Undelivered Protection, SecureKaro has credited ${fmt(supplierRelief)} to your wallet to reduce your courier and packaging loss burden.`,
          'payment'
        );
      } else if (supplierBuyerPenaltyShare > 0) {
        // Buyer's 3rd+ rejection: seller gets ₹30 share of the buyer's ₹40 penalty
        await createNotification(
          supplier._id,
          'local_shipping',
          `Buyer Penalty Share Credited: +${fmt(supplierBuyerPenaltyShare)}`,
          `Shipment ${shipment.shipmentId} was rejected/undelivered (${reason}). ` +
          `The buyer was charged a ₹40 fair-play fee (3rd+ rejection this week). ` +
          `Your compensation of ${fmt(supplierBuyerPenaltyShare)} has been credited to your wallet.`,
          'payment'
        );
      }
    } else {
      // RTO Protection OFF — standard notification
      await createNotification(
        supplier._id,
        'local_shipping',
        `Shipment Undelivered: ${shipment.shipmentId}`,
        `Carrier marked shipment ${shipment.shipmentId} as undelivered (${reason}). ` +
        `Escrow funds (${formattedPrincipal}) have been refunded to the receiver.`,
        'alert'
      );
    }
  }

  return {
    shipment,
    refundSummary: {
      principal,
      daysHeld,
      rtoProtectionEnabled: shipment.rtoProtectionEnabled || false,
      supplierRelief,
      supplierBuyerPenaltyShare,
      totalSupplierCredit: supplierRelief + supplierBuyerPenaltyShare,
      receiverPenalty,
      receiverRefund,
      receiverWeeklyRejectionCount
    }
  };
};

/**
 * Initiates a return request with one of three resolution paths:
 *   'full_refund'       — reverse courier AWB issued; principal refunded on receipt
 *   'replacement'       — replacement order flagged for supplier approval
 *   'partial_discount'  — buyer uploads defect photo; supplier sets discount offer
 */
const requestReturnEscrow = async (
  shipmentId,
  receiverId,
  reason = 'Product issue / Return requested',
  returnType = 'full_refund',
  defectPhotoUrl = '',
  defectDescription = ''
) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });

  if (!shipment) {
    throw new Error('Shipment not found');
  }

  if (shipment.status === 'Released') {
    throw new Error('Cannot request return after escrow funds have been released');
  }

  if (['Cancelled', 'Returned & Refunded', 'Return Requested', 'Return In Transit'].includes(shipment.status) || shipment.returnRequested) {
    throw new Error('Return request has already been applied for this shipment');
  }

  if (shipment.returnAllowed === false) {
    throw new Error('Product returns have not been enabled for this parcel by the seller');
  }

  // Returns can only be requested after the parcel has been delivered
  if (shipment.status !== 'Delivered' && !shipment.deliveryConfirmed) {
    throw new Error('Returns can only be requested after the parcel has been delivered to the receiver');
  }

  // Verify return window has not expired
  if (shipment.returnWindowClosed) {
    throw new Error('Return window is closed for this shipment');
  }
  if (shipment.returnWindowExpiresAt && new Date() > new Date(shipment.returnWindowExpiresAt)) {
    throw new Error('24-hour return window has expired for this shipment');
  }

  // Validate returnType
  const validTypes = ['full_refund', 'replacement', 'partial_discount'];
  const resolvedType = validTypes.includes(returnType) ? returnType : 'full_refund';

  // Mandatory photo proof check across all return types (full_refund, replacement, partial_discount)
  if (!defectPhotoUrl || typeof defectPhotoUrl !== 'string' || !defectPhotoUrl.trim()) {
    throw new Error('Uploading photo proof of the package/item is mandatory for refund, partial return, and replacement requests.');
  }

  shipment.returnStatus = 'Requested';
  shipment.returnReason = reason || 'Receiver requested return under 24h window';
  shipment.returnRequestedAt = new Date();
  shipment.status = 'Return Requested';
  shipment.escrowStage = -4;
  shipment.returnType = resolvedType;

  // Attach defect / package evidence photo & description for all return types
  shipment.defectPhotoUrl = defectPhotoUrl.trim();
  if (defectDescription) shipment.defectDescription = defectDescription.trim();

  await shipment.save();

  // Add Reverse Milestone to CarrierJourney
  const CarrierJourney = require('../models/CarrierJourney');
  let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
  if (journey) {
    const milestoneDetail = {
      full_refund: `Buyer requested full refund (${reason || 'Buyer requested'}). Awaiting supplier to assign reverse courier & tracking ID.`,
      replacement: `Buyer requested product replacement (${reason || 'Buyer requested'}). Awaiting supplier approval in Return Orders.`,
      partial_discount: `Buyer requested partial discount/refund on defective product (${reason || 'Buyer requested'}). Defect photo submitted. Awaiting supplier discount offer.`
    }[resolvedType];

    journey.milestones.push({
      status: 'Return Requested',
      location: 'Receiver Address',
      detail: milestoneDetail,
      time: new Date()
    });
    await journey.save();
  }

  const formattedAmount = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;

  // Supplier notification — varies by return type
  const supplierNotifMap = {
    full_refund: `Buyer applied for a FULL REFUND for parcel #${shipment.shipmentId} (Reason: ${reason}). Please assign the reverse courier partner & tracking ID in Return Orders. Escrow of ${formattedAmount} is frozen.`,
    replacement: `Buyer applied for a REPLACEMENT for parcel #${shipment.shipmentId} (Reason: ${reason}). Please review and approve/reject this request in Return Orders. Escrow of ${formattedAmount} is frozen.`,
    partial_discount: `Buyer applied for a PARTIAL DISCOUNT/REFUND for parcel #${shipment.shipmentId} (Reason: ${reason}). Buyer uploaded defect photo — review it in Return Orders and set a discount offer price. Escrow of ${formattedAmount} is frozen.`
  };

  await createNotification(
    shipment.senderId,
    'swap_horizontal_circle',
    `Return Requested (${resolvedType.replace('_', ' ').toUpperCase()}) — ${shipment.shipmentId}`,
    supplierNotifMap[resolvedType],
    'alert',
    shipment.shipmentId,
    'RETURN_ORDERS'
  );

  // Receiver notification — varies by return type
  const receiverNotifMap = {
    full_refund: `Your full refund request for parcel #${shipment.shipmentId} has been submitted. You will be notified once the supplier assigns the reverse courier partner.`,
    replacement: `Your replacement request for parcel #${shipment.shipmentId} has been submitted to the supplier. You will be notified once the supplier approves or rejects the replacement.`,
    partial_discount: `Your partial discount request for parcel #${shipment.shipmentId} has been submitted with your defect photo. The supplier will review it and make a discount offer. You can accept or reject the offer.`
  };

  const receiver = await findReceiverUser(shipment);
  if (receiver) {
    await createNotification(
      receiver._id,
      'assignment_return',
      `Return Application Submitted — ${shipment.shipmentId}`,
      receiverNotifMap[resolvedType],
      'shipping',
      shipment.shipmentId
    );
  }

  return shipment;
};



/**
 * Approves a return request and assigns reverse courier partner and tracking ID.
 * Notifies the receiver with the reverse courier details.
 */
const approveReturnEscrow = async (shipmentId, courierData = {}, supplierId = null) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });

  if (!shipment) {
    throw new Error('Shipment not found');
  }

  // In partial discount returns, reverse courier is ONLY needed if buyer rejected the offer
  if (shipment.returnType === 'partial_discount') {
    if (shipment.discountAccepted === true) {
      throw new Error('Partial discount has already been accepted by the buyer. The buyer keeps the product, so no reverse courier is needed.');
    }
    if (shipment.discountAccepted !== false) {
      throw new Error('Cannot book reverse courier for a partial discount return until the buyer responds. If the buyer accepts the offer, they keep the product.');
    }
  }

  const { getCheapestPickupCarrier } = require('./carrierRateService');

  // Reverse pickup is from the Buyer (receiver) to the Supplier (sender)
  const fromPincode = shipment.receiverPincode || '110001';
  const toPincode = shipment.senderPincode || '700001';
  const weightKg = shipment.parcelWeight || 0.5;
  const dims = {
    length: shipment.parcelLength || 15,
    width: shipment.parcelWidth || 10,
    height: shipment.parcelHeight || 5
  };

  let carrierSlug = courierData.carrierSlug;
  let carrierName = courierData.carrierName;
  let trackingId = courierData.trackingId || courierData.awbCode;
  let shippingRate = 0;
  let savingsAmount = 0;
  let comparison = [];
  let isAutoBooked = false;

  // Auto-find cheapest courier across all partners if not explicitly specified
  if (!carrierSlug || carrierSlug === 'auto') {
    const rateResult = getCheapestPickupCarrier(fromPincode, toPincode, weightKg, dims);
    const cheapest = rateResult.cheapest;
    carrierSlug = cheapest.slug;
    carrierName = cheapest.name;
    shippingRate = cheapest.price;
    savingsAmount = rateResult.savingsAmount;
    comparison = rateResult.comparison;
    isAutoBooked = true;
  } else {
    carrierName = courierData.carrierName || (carrierSlug ? carrierSlug.toUpperCase() + ' Express' : 'Delhivery Express');
  }

  if (!trackingId) {
    const prefix = carrierSlug.toUpperCase().substring(0, 3);
    trackingId = `REV-${prefix}-${Math.floor(10000000 + Math.random() * 90000000)}`;
  }

  // Calculate scheduled pickup window (Next business day 10:00 AM – 2:00 PM)
  const pickupDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const formattedPickupDate = pickupDate.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
  const pickupWindow = courierData.pickupWindow || `Tomorrow (${formattedPickupDate}), 10:00 AM – 2:00 PM`;

  shipment.returnCarrierSlug = carrierSlug;
  shipment.returnCarrierName = carrierName;
  shipment.returnAwbCode = trackingId;
  shipment.returnShippingRate = shippingRate;
  shipment.returnEstimatedSavings = savingsAmount;
  shipment.returnPickupWindow = pickupWindow;
  shipment.returnAutoBooked = isAutoBooked;
  shipment.returnCarrierComparison = comparison;
  shipment.returnStatus = 'In Return Transit';
  shipment.status = 'Return In Transit';
  shipment.returnApprovedAt = new Date();
  shipment.returnReversePickupScheduledAt = pickupDate;
  if (supplierId) {
    shipment.returnReverseCourierDetailsAddedBy = supplierId;
  }

  // Send Reverse Courier Assigned SMS to Receiver with pickup window
  const smsService = require('./smsService');
  try {
    const smsRes = await smsService.sendReverseCourierAssignedSms({
      phone: shipment.receiverPhone,
      shipmentId: shipment.shipmentId,
      carrierName,
      trackingId,
      pickupWindow
    });
    shipment.returnSmsNotification = smsRes.smsText;
  } catch (err) {
    console.warn('SMS dispatch non-blocking error:', err.message);
  }

  await shipment.save();

  // Add Reverse Milestone to CarrierJourney
  const CarrierJourney = require('../models/CarrierJourney');
  let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
  if (journey) {
    journey.milestones.push({
      status: 'Reverse Courier Auto-Booked (Cheapest Rate Selected)',
      location: `${shipment.city || 'Buyer City'} Pickup Hub`,
      detail: `Reverse courier automatically booked with ${carrierName} at lowest delivery rate ₹${shippingRate || 38}${savingsAmount ? ` (Saved ₹${savingsAmount} via multi-carrier comparison)` : ''}. Reverse AWB: ${trackingId}. Scheduled Pickup Window: ${pickupWindow}.`,
      time: new Date()
    });
    await journey.save();
  }

  // 1. Notify Receiver about assigned reverse carrier service partner, tracking ID and scheduled pickup window
  const receiver = await User.findOne({ phone: shipment.receiverPhone });
  if (receiver) {
    await createNotification(
      receiver._id,
      'local_shipping',
      `Reverse Pickup Scheduled: ${carrierName} (${trackingId})`,
      `Supplier approved your return for #${shipment.shipmentId}. Return courier automatically booked with ${carrierName} (Tracking ID: ${trackingId}). Pickup Window: ${pickupWindow}. Please keep the parcel packed and ready for collection.`,
      'confirmed',
      shipment.shipmentId
    );
  }

  // 2. Notify Supplier confirming auto-booking & cost savings
  if (shipment.senderId) {
    await createNotification(
      shipment.senderId,
      'check_circle',
      `Reverse Courier Auto-Booked — ${shipment.shipmentId}`,
      `Reverse courier ${carrierName} auto-booked at lowest delivery rate (₹${shippingRate || 38}${savingsAmount ? `, saved ₹${savingsAmount}` : ''}). Tracking ID: ${trackingId}. Scheduled pickup: ${pickupWindow}.`,
      'confirmed',
      shipment.shipmentId,
      'RETURN_ORDERS'
    );
  }

  return shipment;
};

/**
 * Confirms receipt of returned package at supplier warehouse and refunds principal to receiver.
 */
const confirmReturnReceivedEscrow = async (shipmentId) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });

  if (!shipment) {
    throw new Error('Shipment not found');
  }

  // Calculate days held
  const createdDate = shipment.createdAt ? new Date(shipment.createdAt) : new Date();
  const daysHeld = Math.max(1, Math.ceil((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));
  const formattedPrincipal = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;
  const isPaidOffline = shipment.paymentMode === 'paid_offline';
  const receiver = await findReceiverUser(shipment);
  const supplier = await User.findById(shipment.senderId);

  // ── Case 1: REPLACEMENT ───────────────────────────────────────────────────
  // In a replacement, the buyer receives a replacement item and the supplier receives
  // the old defective item back. The buyer DOES NOT get refunded — the sale is complete
  // and the escrow payment is released to the SUPPLIER.
  if (shipment.returnType === 'replacement') {
    shipment.returnStatus = 'Completed';
    const feeCalc = calculateServiceFee(shipment.amount); // fee = 0, escrow is free
    const serviceFee = feeCalc.fee; // 0
    const netPayout = Math.max(0, parseFloat((shipment.amount - serviceFee).toFixed(2))); // full amount

    shipment.principalDisbursedToSupplier = netPayout;
    shipment.serviceFeeDeducted = serviceFee;
    shipment.gatewayFeeDeducted = serviceFee;
    shipment.gatewayFeeRate = feeCalc.rate;
    shipment.principalRefundedToReceiver = 0;
    shipment.confirmationWindowClosed = true;
    shipment.withdrawableAt = new Date();
    await shipment.save();

    if (!isPaidOffline && supplier) {
      supplier.walletBalance = parseFloat(((Number(supplier.walletBalance) || 0) + netPayout).toFixed(2));
      await supplier.save();
    }

    if (isPaidOffline) {
      if (supplier) {
        await createNotification(
          supplier._id,
          'check_circle',
          `Replacement Complete: Package Received — ${shipment.shipmentId}`,
          `Returned defective package for ${shipment.shipmentId} arrived at your warehouse. Replacement order is complete.`,
          'confirmed',
          shipment.shipmentId
        );
      }
      if (receiver) {
        await createNotification(
          receiver._id,
          'verified',
          `Replacement Complete — ${shipment.shipmentId}`,
          `The seller received your returned item for replacement #${shipment.shipmentId}. Your replacement order is successfully completed.`,
          'confirmed',
          shipment.shipmentId
        );
      }
    } else {
      // Escrow / Prepaid: Release funds to supplier's wallet
      if (supplier) {
        supplier.walletBalance = parseFloat(((Number(supplier.walletBalance) || 0) + (Number(shipment.amount) || 0)).toFixed(2));
        await supplier.save();

        await createNotification(
          supplier._id,
          'payments',
          `Replacement Complete: Escrow Released — ${shipment.shipmentId}`,
          `Defective item for ${shipment.shipmentId} arrived at your warehouse. Replacement complete! Escrow principal (${formattedPrincipal}) has been credited to your wallet.`,
          'payment',
          shipment.shipmentId
        );
      }

      if (receiver) {
        await createNotification(
          receiver._id,
          'verified',
          `Replacement Complete — ${shipment.shipmentId}`,
          `The seller received your returned item for replacement #${shipment.shipmentId}. Your replacement order is successfully completed.`,
          'confirmed',
          shipment.shipmentId
        );
      }
    }

    return {
      shipment,
      isReplacement: true,
      message: `Old item received! Replacement complete and escrow payment of ${formattedPrincipal} disbursed to supplier.`
    };
  }

  // ── Case 2: STANDARD RETURN (FULL REFUND) ──────────────────────────────────
  shipment.returnStatus = 'Returned & Refunded';
  shipment.status = 'Returned & Refunded';
  shipment.escrowStage = -5;
  shipment.daysInEscrow = daysHeld;
  shipment.accruedInterest = 0;
  shipment.receiverInterestPaid = 0;
  shipment.supplierInterestPaid = 0;
  shipment.principalRefundedToReceiver = shipment.amount;
  await shipment.save();

  if (isPaidOffline) {
    // On paid_offline, buyer paid supplier directly outside platform escrow.
    // If supplier has sufficient wallet balance, adjust from supplier wallet to receiver wallet;
    // otherwise notify both parties to settle offline refund directly.
    const principalNum = Number(shipment.amount) || 0;
    if (supplier && (Number(supplier.walletBalance) || 0) >= principalNum && receiver) {
      supplier.walletBalance = parseFloat(Math.max(0, (Number(supplier.walletBalance) || 0) - principalNum).toFixed(2));
      await supplier.save();

      receiver.walletBalance = parseFloat(((Number(receiver.walletBalance) || 0) + principalNum).toFixed(2));
      await receiver.save();

      await createNotification(
        receiver._id,
        'payments',
        `Return Processed: Refund Credited — ${shipment.shipmentId}`,
        `Returned parcel ${shipment.shipmentId} arrived at supplier. Refund of ${formattedPrincipal} has been adjusted from supplier and credited to your wallet.`,
        'payment',
        shipment.shipmentId
      );
    } else {
      // Direct offline settlement notice
      if (receiver) {
        await createNotification(
          receiver._id,
          'payments',
          `Return Complete: Offline Settlement — ${shipment.shipmentId}`,
          `Returned parcel ${shipment.shipmentId} was received by supplier. Since this order was paid offline directly to the supplier, the supplier will refund ${formattedPrincipal} directly to your UPI/Bank.`,
          'payment',
          shipment.shipmentId
        );
      }
    }

    if (supplier) {
      await createNotification(
        supplier._id,
        'wallet',
        `Return Complete: Package Received — ${shipment.shipmentId}`,
        `Returned package ${shipment.shipmentId} arrived at your warehouse. Order marked Returned. Please ensure buyer's offline refund of ${formattedPrincipal} is settled.`,
        'confirmed',
        shipment.shipmentId
      );
    }
  } else {
    // Online Escrow & COD remittance cases: funds held/settled by platform vault
    if (receiver) {
      const refundAmt = Number(shipment.amount) || 0;
      const balBefore = Number(receiver.walletBalance) || 0;
      receiver.walletBalance = parseFloat((balBefore + refundAmt).toFixed(2));
      await receiver.save();
      try {
        const { recordTransaction } = require('./walletService');
        await recordTransaction({
          userId: receiver._id,
          type: 'credit',
          amount: refundAmt,
          source: 'refund',
          description: `Return processed: Escrow refund credited for ${shipment.shipmentId}`,
          balanceBefore: balBefore,
          balanceAfter: receiver.walletBalance,
          metadata: { shipmentId: shipment.shipmentId }
        });
      } catch (e) {}
      await createNotification(
        receiver._id,
        'payments',
        `Return Processed: Escrow Refunded — ${shipment.shipmentId}`,
        `Returned parcel ${shipment.shipmentId} was received by supplier. Principal (${formattedPrincipal}) has been refunded to your wallet.`,
        'payment',
        shipment.shipmentId
      );
    }

    if (supplier) {
      await createNotification(
        supplier._id,
        'wallet',
        `Return Complete: Package Received — ${shipment.shipmentId}`,
        `Returned package ${shipment.shipmentId} arrived at your warehouse. Escrow refund processed to receiver.`,
        'confirmed',
        shipment.shipmentId
      );
    }
  }

  return {
    shipment,
    refundSummary: {
      daysHeld,
      receiverPrincipalRefund: shipment.amount
    }
  };
};

/**
 * Confirms parcel delivery with two options for the Receiver:
 * Option 1: Confirm and close the Return window (immediate release of funds)
 * Option 2: Confirm without closing Return window (24-hour return window active)
 */
const confirmDelivery = async (shipmentId, receiverId, { choice = 'keep_open_24h' } = {}) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });

  if (!shipment) {
    throw new Error('Shipment not found');
  }

  // Check if parcel delivery has already been confirmed (either with window closed or open)
  if (shipment.deliveryConfirmed || shipment.status === 'Released') {
    const isClosed = shipment.returnWindowClosed || shipment.status === 'Released' || shipment.returnWindowChoice === 'ImmediateClose';
    const isExpired = shipment.returnWindowExpiresAt && new Date() >= new Date(shipment.returnWindowExpiresAt);
    const windowDetail = isClosed
      ? 'Return window is closed and escrow funds have been released.'
      : isExpired
        ? 'The 24-hour return window has expired.'
        : `24-hour return window is currently active until ${new Date(shipment.returnWindowExpiresAt).toLocaleString('en-IN')}.`;
    throw new Error(`Parcel already confirmed. ${windowDetail}`);
  }

  if (shipment.escrowStage === -1 || shipment.status === 'Locked') {
    throw new Error('Cannot confirm parcel while escrow is locked under an active dispute claim');
  }

  const CarrierJourney = require('../models/CarrierJourney');
  let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });

  // Option 1: Confirm and close the Return window
  if (choice === 'immediate' || choice === 'confirm_and_close') {
    const result = await releaseEscrow(shipmentId, receiverId);
    result.shipment.deliveryConfirmed = true;
    result.shipment.deliveryConfirmedAt = new Date();
    result.shipment.returnWindowClosed = true;
    result.shipment.returnWindowExpiresAt = new Date();
    result.shipment.returnWindowChoice = 'ImmediateClose';
    result.shipment.returnClosedAt = new Date();
    await result.shipment.save();

    if (journey) {
      journey.milestones.push({
        status: 'Delivered & Confirmed (Return Window Closed)',
        location: 'Receiver Address',
        detail: 'Receiver confirmed delivery and closed the return window. Escrow funds released to supplier.',
        time: new Date()
      });
      await journey.save();
    }

    return {
      shipment: result.shipment,
      settlement: result.settlement,
      message: 'Parcel confirmed and return window closed. Escrow funds released successfully!'
    };
  }

  // Option 2: Confirm without closing Return window (default)
  // Check if returns are allowed by seller
  if (shipment.returnAllowed === false) {
    throw new Error('Returns are not enabled for this parcel by the seller. You can only confirm and close the return window.');
  }

  // Activates 24-hour return window
  const windowDurationMs = 24 * 60 * 60 * 1000; // 24 hours
  const expiresAt = new Date(Date.now() + windowDurationMs);

  shipment.deliveryConfirmed = true;
  shipment.deliveryConfirmedAt = new Date();
  shipment.returnWindowExpiresAt = expiresAt;
  shipment.returnWindowClosed = false;
  shipment.returnWindowChoice = 'KeepOpen24h';
  if (shipment.status !== 'Delivered') {
    shipment.status = 'Delivered';
    shipment.escrowStage = 5;
  }
  await shipment.save();

  if (journey) {
    journey.milestones.push({
      status: 'Delivery Confirmed (24h Return Window Active)',
      location: 'Receiver Address',
      detail: 'Receiver confirmed parcel delivery. 24-hour return window initiated.',
      time: new Date()
    });
    await journey.save();
  }

  // Notify receiver
  const receiver = await findReceiverUser(shipment);
  if (receiver) {
    await createNotification(
      receiver._id,
      'inventory_2',
      `Parcel Confirmed — 24-Hour Return Window Active`,
      `You confirmed parcel #${shipment.shipmentId}. The return window will close after 24 hours.`,
      'confirmed',
      shipment.shipmentId
    );
  }

  // Notify supplier
  await createNotification(
    shipment.senderId,
    'local_shipping',
    `Parcel Receipt Confirmed: ${shipment.shipmentId}`,
    `Buyer confirmed delivery of parcel ${shipment.shipmentId}. The 24-hour return window is now active.`,
    'shipping',
    shipment.shipmentId
  );

  return {
    shipment,
    returnWindowExpiresAt: expiresAt,
    message: 'The return window will close after 24 hours'
  };
};

/**
 * Receiver closes/withdraws an active return request.
 */
const closeReturnRequest = async (shipmentId, receiverId) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });

  if (!shipment) {
    throw new Error('Shipment not found');
  }

  if (shipment.returnStatus !== 'Requested' && shipment.status !== 'Return Requested') {
    throw new Error('There is no active return request to close for this shipment');
  }

  // Reset return status
  shipment.returnStatus = 'None';
  shipment.returnClosedAt = new Date();

  // Check if the 24-hour return window has expired in the meantime
  const hasExpired = shipment.returnWindowExpiresAt && new Date() >= new Date(shipment.returnWindowExpiresAt);

  const CarrierJourney = require('../models/CarrierJourney');
  let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
  if (journey) {
    journey.milestones.push({
      status: 'Return Request Closed',
      location: 'Receiver Address',
      detail: 'Receiver withdrew and closed the return request.',
      time: new Date()
    });
    await journey.save();
  }

  if (hasExpired) {
    // If window expired, release escrow immediately
    const releaseRes = await releaseEscrow(shipmentId, receiverId);
    releaseRes.shipment.returnStatus = 'None';
    releaseRes.shipment.returnWindowClosed = true;
    releaseRes.shipment.returnClosedAt = new Date();
    await releaseRes.shipment.save();

    return {
      shipment: releaseRes.shipment,
      message: 'Return request closed. 24-hour return window had expired, so escrow funds have now been released.'
    };
  }

  // Otherwise revert back to Delivered state with active window
  shipment.status = 'Delivered';
  shipment.escrowStage = 5;
  await shipment.save();

  // Notifications
  const receiver = await findReceiverUser(shipment, receiverId);
  if (receiver) {
    await createNotification(
      receiver._id,
      'verified',
      `Return Request Closed: ${shipment.shipmentId}`,
      `You closed the return request for parcel #${shipment.shipmentId}. Escrow remains protected until return window conclusion.`,
      'confirmed',
      shipment.shipmentId
    );
  }

  await createNotification(
    shipment.senderId,
    'local_shipping',
    `Return Request Closed by Buyer: ${shipment.shipmentId}`,
    `The buyer closed their return request for parcel ${shipment.shipmentId}.`,
    'shipping',
    shipment.shipmentId
  );

  return {
    shipment,
    message: 'Return request closed successfully.'
  };
};

/**
 * Receiver closes the 24-hour return window early and releases escrow funds.
 */
const closeReturnWindow = async (shipmentId, receiverId) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });

  if (!shipment) {
    throw new Error('Shipment not found');
  }

  if (shipment.status === 'Released' || shipment.returnWindowClosed) {
    throw new Error('Return window is already closed and funds released');
  }

  const result = await releaseEscrow(shipmentId, receiverId);
  result.shipment.returnWindowClosed = true;
  result.shipment.returnClosedAt = new Date();
  await result.shipment.save();

  return {
    shipment: result.shipment,
    message: 'Return window closed early. Escrow funds released to supplier successfully!'
  };
};

/**
 * Lazy-check helper: Auto-close return window after 24 hours if no return was requested.
 */
const checkAndAutoCloseReturnWindow = async (shipment) => {
  if (!shipment) return shipment;

  if (
    shipment.deliveryConfirmed &&
    !shipment.returnWindowClosed &&
    shipment.returnWindowExpiresAt &&
    new Date() >= new Date(shipment.returnWindowExpiresAt) &&
    shipment.returnStatus !== 'Requested' &&
    shipment.status !== 'Released' &&
    shipment.status !== 'Locked' &&
    shipment.status !== 'Cancelled' &&
    shipment.status !== 'Undelivered' &&
    !shipment.status?.includes('Return')
  ) {
    try {
      console.log(`[RETURN WINDOW AUTO-CLOSE] 24h return window expired for ${shipment.shipmentId}. Releasing escrow to supplier...`);
      await releaseEscrow(shipment.shipmentId);
      const updated = await Shipment.findOne({ shipmentId: shipment.shipmentId });
      if (updated) {
        updated.returnWindowClosed = true;
        updated.returnClosedAt = new Date();
        await updated.save();
        return updated;
      }
    } catch (err) {
      console.error(`[RETURN WINDOW AUTO-CLOSE] Error auto-closing return window for ${shipment.shipmentId}:`, err.message);
    }
  }

  return shipment;
};

/**
 * Calculates a supplier's total payments received in the current calendar month.
 */
const getSupplierMonthlyVolume = async (supplierId) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  // Find all shipments where supplier is sender and funds have been funded/received this month
  const shipments = await Shipment.find({
    senderId: supplierId,
    status: { $in: ['Pending Pickup', 'In Transit', 'Reached Destination Hub', 'Out for Delivery', 'Delivered', 'Released'] },
    $or: [
      { receiverPaidAt: { $gte: startOfMonth, $lte: endOfMonth } },
      { createdAt: { $gte: startOfMonth, $lte: endOfMonth } }
    ]
  });

  const currentMonthVolume = shipments.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);

  return {
    currentMonthVolume,
    threshold: 0,
    isOverThreshold: false,
    remainingBeforeFee: 0,
    feeRate: 0,
    totalShipmentsInMonth: shipments.length,
    monthName: now.toLocaleString('en-IN', { month: 'long', year: 'numeric' })
  };
};

/**
 * Option 2 — Supplier sets a discount offer for a partial_discount return.
 * Notifies the buyer with the offer amount so they can accept or reject.
 * Also supports direct/immediate partial refund execution for COD and prepaid orders.
 */
const offerPartialDiscount = async (shipmentId, supplierId, discountAmount) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  if (!shipment) throw new Error('Shipment not found');

  if (!discountAmount || discountAmount <= 0) throw new Error('Discount amount must be greater than 0');
  if (discountAmount > shipment.amount) throw new Error('Discount amount cannot exceed the total order amount');

  // Automatically ensure returnType is partial_discount
  shipment.returnType = 'partial_discount';

  if (shipment.status !== 'Return Requested') {
    throw new Error('Partial discount can only be offered when return is in Requested state');
  }

  shipment.discountOfferedAmount = parseFloat(discountAmount.toFixed(2));
  shipment.discountOfferedAt = new Date();
  shipment.partialRefundAmount = parseFloat(discountAmount.toFixed(2));
  shipment.partialRefundStatus = 'Offered';
  shipment.partialRefundAt = new Date();
  if (supplierId) shipment.partialRefundBy = supplierId;

  await shipment.save();

  const fmt = (n) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;
  const receiver = await findReceiverUser(shipment);
  if (receiver) {
    await createNotification(
      receiver._id,
      'sell',
      `Partial Refund Offer: ${fmt(discountAmount)} — ${shipment.shipmentId}`,
      `The supplier reviewed parcel #${shipment.shipmentId} and offered a partial discount/refund of ${fmt(discountAmount)} (original order: ${fmt(shipment.amount)}). ` +
      `If you ACCEPT: ${fmt(discountAmount)} will be credited to your wallet and you keep the item. ` +
      `Open the shipment in your app to respond.`,
      'payment',
      shipment.shipmentId
    );
  }

  return { shipment, discountOfferedAmount: discountAmount };
};

/**
 * Option 2 — Buyer or Supplier accepts or rejects a partial-discount offer.
 *   Accept  → discountAmount credited to buyer wallet; remainder released to supplier; escrow closed.
 *   Reject  → full principal refunded to buyer; supplier gets ₹0.
 */
const respondToDiscount = async (shipmentId, responderId, accepted, isSupplier = false) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  if (!shipment) throw new Error('Shipment not found');
  shipment.returnType = 'partial_discount';

  if (!shipment.discountOfferedAmount || shipment.discountOfferedAmount <= 0) {
    throw new Error('No discount offer found to respond to');
  }

  if (shipment.discountAccepted === true) {
    throw new Error('This discount offer has already been accepted and settled.');
  }
  if (shipment.discountAccepted === false) {
    throw new Error('This discount offer has already been rejected and return courier booked.');
  }

  // Identity Verification:
  if (!isSupplier) {
    if (responderId) {
      const responder = await User.findById(responderId);
      const userPhone = responder ? (responder.phone || '').replace(/\D/g, '').slice(-10) : '';
      const shipmentReceiverPhone = (shipment.receiverPhone || '').replace(/\D/g, '').slice(-10);
      const isAuthorizedBuyer = responder && (
        responder.role === 'Admin' ||
        (shipment.receiverId && String(shipment.receiverId) === String(responder._id)) ||
        (userPhone && shipmentReceiverPhone && userPhone === shipmentReceiverPhone) ||
        (shipment.receiverPhone && responder.phone && shipment.receiverPhone === responder.phone)
      );

      if (!isAuthorizedBuyer) {
        throw new Error('Unauthorized: Only the intended recipient/buyer of this shipment is authorized to accept or reject this discount offer.');
      }
    }
  } else {
    // Seller/Supplier permission check:
    // Seller cannot arbitrarily approve or reject without buyer approval unless the 15-hour buyer window has elapsed.
    if (!accepted) {
      throw new Error('Only the buyer can reject a discount offer to trigger a product return.');
    }

    const offeredAt = shipment.discountOfferedAt ? new Date(shipment.discountOfferedAt).getTime() : 0;
    if (!offeredAt) {
      throw new Error('No valid discount offer timestamp found.');
    }

    const now = Date.now();
    const elapsedMs = now - offeredAt;
    const fifteenHoursMs = 15 * 60 * 60 * 1000;

    if (elapsedMs < fifteenHoursMs) {
      const remainingMs = fifteenHoursMs - elapsedMs;
      const totalMinutes = Math.ceil(remainingMs / (1000 * 60));
      const remainingHours = Math.floor(totalMinutes / 60);
      const remainingMins = totalMinutes % 60;
      const remainingStr = remainingHours > 0 
        ? `${remainingHours}h ${remainingMins}m` 
        : `${remainingMins} minute${remainingMins === 1 ? '' : 's'}`;
      throw new Error(
        `Buyer has a 15-hour window to review and respond to your discount offer. You can only auto-complete the refund if the buyer does not respond after 15 hours (${remainingStr} remaining).`
      );
    }

    shipment.discountAutoCompletedBySupplier = true;
  }

  const fmt = (n) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;
  const principal = Number(shipment.amount) || 0;
  const discountAmount = Number(shipment.discountOfferedAmount) || 0;

  if (accepted) {
    // ── ACCEPTED: split escrow / issue partial refund ────────────────────────
    const buyerCredit = parseFloat(discountAmount.toFixed(2));
    const supplierCredit = parseFloat(Math.max(0, principal - discountAmount).toFixed(2));

    shipment.discountAccepted = true;
    shipment.discountAcceptedAt = new Date();
    shipment.discountBuyerWalletCredited = buyerCredit;
    shipment.discountSupplierWalletCredited = supplierCredit;
    shipment.principalRefundedToReceiver = buyerCredit;
    shipment.partialRefundAmount = buyerCredit;
    shipment.partialRefundStatus = 'Refunded';
    shipment.partialRefundAt = new Date();
    if (responderId) shipment.partialRefundBy = responderId;

    shipment.status = 'Released';
    shipment.escrowStage = 6;
    shipment.returnStatus = 'None';
    await shipment.save();

    const receiver = await findReceiverUser(shipment);
    if (receiver) {
      receiver.walletBalance = parseFloat(((Number(receiver.walletBalance) || 0) + buyerCredit).toFixed(2));
      await receiver.save();
      const notifMsg = isSupplier
        ? `A partial refund of ${fmt(buyerCredit)} for order #${shipment.shipmentId} was auto-completed after the 15-hour response window expired with no response from buyer. The amount is credited to your SecureKaro wallet and you keep the item.`
        : `A partial refund of ${fmt(buyerCredit)} for order #${shipment.shipmentId} has been credited to your SecureKaro wallet. You keep the item.`;
      await createNotification(
        receiver._id,
        'payments',
        `Partial Refund of ${fmt(buyerCredit)} Credited — ${shipment.shipmentId}`,
        notifMsg,
        'payment',
        shipment.shipmentId
      );
    }

    const supplier = await User.findById(shipment.senderId);
    if (supplier) {
      supplier.walletBalance = parseFloat(((Number(supplier.walletBalance) || 0) + supplierCredit).toFixed(2));
      await supplier.save();
      const supplierNotifMsg = isSupplier
        ? `Your discount offer of ${fmt(buyerCredit)} was auto-completed after 15 hours of buyer inactivity. The remaining balance of ${fmt(supplierCredit)} has been released to your wallet.`
        : `The buyer accepted your partial discount offer of ${fmt(buyerCredit)}. The remaining balance of ${fmt(supplierCredit)} has been released to your wallet.`;
      await createNotification(
        supplier._id,
        'payments',
        `Partial Refund ${isSupplier ? 'Auto-Completed' : 'Accepted'}: ${shipment.shipmentId}`,
        supplierNotifMsg,
        'payment',
        shipment.shipmentId
      );
    }

    // Add milestone to CarrierJourney
    try {
      const CarrierJourney = require('../models/CarrierJourney');
      let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
      if (journey) {
        journey.milestones.push({
          status: 'Partial Refund Processed',
          location: 'Resolution Center',
          detail: isSupplier
            ? `Partial refund of ${fmt(buyerCredit)} auto-completed after 15h buyer inactivity. Item retained by buyer.`
            : `Partial refund of ${fmt(buyerCredit)} processed for buyer. Item retained by buyer.`,
          time: new Date()
        });
        await journey.save();
      }
    } catch (jErr) {}

    return { 
      success: true, 
      shipment, 
      outcome: 'accepted', 
      buyerCredit, 
      supplierCredit,
      autoCompleted: Boolean(isSupplier),
      message: isSupplier
        ? `Partial refund of ${fmt(buyerCredit)} auto-completed after 15-hour buyer response window expired.`
        : `Partial refund of ${fmt(buyerCredit)} successfully processed!`
    };

  } else {
    // ── REJECTED: Buyer refuses discount and returns product for full refund ──
    shipment.discountAccepted = false;
    shipment.discountAcceptedAt = new Date();
    shipment.partialRefundStatus = 'Rejected';
    shipment.returnReason = `Buyer rejected discount offer of ${fmt(discountAmount)}`;
    await shipment.save();

    // Auto-book reverse courier pickup so the product is collected from the buyer
    const approvedShipment = await approveReturnEscrow(shipment.shipmentId, {}, responderId);

    return { 
      success: true, 
      shipment: approvedShipment, 
      outcome: 'rejected_return_booked', 
      message: `Discount offer rejected. Reverse courier (${approvedShipment.returnCarrierName}) has been auto-booked to collect the product. Full refund will be disbursed once the seller receives the parcel.`
    };
  }
};

/**
 * Option 1 — Step 2: Supplier approves replacement request.
 * Books reverse courier pickup to collect the defective product from the buyer FIRST.
 * The replacement item is dispatched in Step 3 after the seller receives and inspects the old item.
 */
const approveReplacement = async (shipmentId, supplierId, courierData = {}) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  if (!shipment) throw new Error('Shipment not found');
  if (shipment.returnType !== 'replacement') throw new Error('This shipment is not a replacement return');
  if (shipment.status !== 'Return Requested') throw new Error('Replacement can only be approved when return is in Requested state');

  const { getCheapestPickupCarrier } = require('./carrierRateService');
  const CarrierJourney = require('../models/CarrierJourney');

  const dims = {
    length: shipment.parcelLength || 15,
    width: shipment.parcelWidth || 10,
    height: shipment.parcelHeight || 5
  };

  // ── Reverse Pickup Leg: Buyer → Supplier (collect defective product) ────────
  let revSlug = courierData.carrierSlug;
  let revName = courierData.carrierName;
  let revAwb  = courierData.trackingId || courierData.awbCode;
  let revPickupRate = 0;

  if (!revSlug || revSlug === 'auto') {
    const revRate = getCheapestPickupCarrier(
      shipment.receiverPincode || '110001',   // pickup from buyer
      shipment.senderPincode   || '700001',   // deliver old item back to supplier
      shipment.parcelWeight    || 0.5,
      dims
    );
    revSlug = revRate.cheapest.slug;
    revName = revRate.cheapest.name;
    revPickupRate = revRate.cheapest.price || 38;
  } else {
    revName = revName || 'Delhivery Express';
    revPickupRate = 45;
  }

  if (!revAwb) {
    revAwb = `REV-${revSlug.toUpperCase().substring(0, 3)}-${Math.floor(10000000 + Math.random() * 90000000)}`;
  }

  // Calculate scheduled pickup window for the reverse leg (next business day)
  const pickupDate      = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const formattedDate   = pickupDate.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const revPickupWindow = `Tomorrow (${formattedDate}), 10:00 AM – 2:00 PM`;

  // ── Persist reverse pickup leg on shipment ──────────────────────────────────
  shipment.replacementApproved      = true;
  shipment.replacementApprovedAt    = new Date();
  shipment.oldItemReceivedBySupplier = false;
  shipment.replacementItemDispatched = false;
  shipment.replacementDelivered     = false;

  // Reverse pickup leg details
  shipment.replacementPickupCarrierSlug  = revSlug;
  shipment.replacementPickupCarrierName  = revName;
  shipment.replacementPickupAwbCode      = revAwb;
  shipment.replacementPickupWindow       = revPickupWindow;
  shipment.replacementPickupScheduledAt  = pickupDate;
  shipment.replacementPickupRate         = revPickupRate;
  if (supplierId) shipment.replacementPickupBookedBy = supplierId;

  // Mirror reverse courier details in returnCarrier* fields for tracking timeline
  shipment.returnCarrierSlug    = revSlug;
  shipment.returnCarrierName    = revName;
  shipment.returnAwbCode        = revAwb;
  shipment.returnPickupWindow   = revPickupWindow;
  shipment.returnShippingRate   = revPickupRate;
  shipment.returnReversePickupScheduledAt = pickupDate;

  shipment.returnStatus = 'In Return Transit';
  shipment.status       = 'Return In Transit';

  await shipment.save();

  // ── CarrierJourney milestone ───────────────────────────────────────────────
  const journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
  if (journey) {
    journey.milestones.push({
      status: `Reverse Pickup Scheduled — ${revName} (${revAwb})`,
      location: `${shipment.city ? shipment.city.split('->')[1]?.trim() : 'Buyer'} Location`,
      detail: `${revName} scheduled to collect defective product from buyer (${revPickupWindow}). Once received & inspected at warehouse, seller will dispatch the new replacement item.`,
      time: new Date()
    });
    await journey.save();
  }

  // ── SMS: notify buyer about pickup of old item ─────────────────────────────
  const smsService = require('./smsService');
  try {
    await smsService.sendReverseCourierAssignedSms({
      phone:       shipment.receiverPhone,
      shipmentId:  shipment.shipmentId,
      carrierName: revName,
      trackingId:  revAwb,
      pickupWindow: revPickupWindow
    });
  } catch (smsErr) {
    console.warn('[approveReplacement] SMS non-blocking error:', smsErr.message);
  }

  // ── In-app notifications ───────────────────────────────────────────────────
  const receiver = await findReceiverUser(shipment);
  if (receiver) {
    await createNotification(
      receiver._id,
      'local_shipping',
      `Replacement Approved — Defective Item Pickup Scheduled`,
      `Your replacement request for #${shipment.shipmentId} has been approved.\n\n` +
      `🔄 Old item pickup: ${revName} will collect the defective product from you (AWB: ${revAwb}) during ${revPickupWindow}. Please keep it packed and ready.\n\n` +
      `Once the seller receives and inspects the returned item at their warehouse, your new replacement item will be dispatched. Your payment remains 100% protected in escrow.`,
      'confirmed',
      shipment.shipmentId
    );
  }

  await createNotification(
    shipment.senderId,
    'check_circle',
    `Replacement Approved — Reverse Pickup Booked (${shipment.shipmentId})`,
    `Reverse courier ${revName} (${revAwb}) booked to collect the defective item from buyer.\n` +
    `Scheduled pickup: ${revPickupWindow}.\n` +
    `When the package arrives at your warehouse, inspect it and dispatch the replacement item.`,
    'confirmed',
    shipment.shipmentId,
    'RETURN_ORDERS'
  );

  return {
    shipment,
    pickupAwbCode:     revAwb,
    pickupCarrierName: revName,
    pickupWindow:      revPickupWindow
  };
};

/**
 * Option 1 — Step 3: Supplier receives old item at warehouse, verifies it, and dispatches replacement item.
 */
const dispatchReplacement = async (shipmentId, supplierId, courierData = {}) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  if (!shipment) throw new Error('Shipment not found');
  if (shipment.returnType !== 'replacement') throw new Error('This shipment is not a replacement return');
  if (shipment.returnStatus !== 'In Return Transit' && shipment.status !== 'Return In Transit') {
    throw new Error('Replacement item can only be dispatched after return pickup is in transit or received');
  }

  const { getCheapestPickupCarrier } = require('./carrierRateService');
  const CarrierJourney = require('../models/CarrierJourney');

  const dims = {
    length: shipment.parcelLength || 15,
    width: shipment.parcelWidth || 10,
    height: shipment.parcelHeight || 5
  };

  // ── Forward Delivery: Supplier → Buyer (dispatch new replacement item) ─────
  let fwdSlug = courierData.carrierSlug;
  let fwdName = courierData.carrierName;
  let fwdAwb  = courierData.trackingId || courierData.awbCode;

  if (!fwdSlug || fwdSlug === 'auto') {
    const fwdRate = getCheapestPickupCarrier(
      shipment.senderPincode   || '700001',
      shipment.receiverPincode || '110001',
      shipment.parcelWeight    || 0.5,
      dims
    );
    fwdSlug = fwdRate.cheapest.slug;
    fwdName = fwdRate.cheapest.name;
  } else {
    fwdName = fwdName || 'Delhivery Express';
  }

  if (!fwdAwb) {
    fwdAwb = `REP-${fwdSlug.toUpperCase().substring(0, 3)}-${Math.floor(10000000 + Math.random() * 90000000)}`;
  }

  // ── Dispatch on Pickup Scan: Generate fresh In-Box QR Token & 6-digit OTP ──
  const crypto = require('crypto');
  const repQrToken = crypto.randomBytes(20).toString('hex');
  const repOtp = String(Math.floor(100000 + Math.random() * 900000));

  shipment.oldItemReceivedBySupplier     = true;
  shipment.oldItemReceivedAt             = shipment.oldItemReceivedAt || new Date();
  shipment.replacementItemDispatched     = true;
  shipment.replacementItemDispatchedAt   = new Date();
  shipment.replacementCarrierSlug        = fwdSlug;
  shipment.replacementCarrierName        = fwdName;
  shipment.replacementAwbCode            = fwdAwb;
  shipment.replacementQrToken            = repQrToken;
  shipment.replacementQrGeneratedAt      = new Date();
  shipment.replacementQrUsed             = false;
  shipment.replacementDeliveryOtp        = repOtp;
  shipment.replacementDeliveryOtpExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  shipment.replacementDeliveryOtpUsed    = false;
  shipment.replacementDispatchedOnPickupScan = true;
  shipment.status                        = 'Replacement In Transit';
  await shipment.save();

  // ── CarrierJourney milestones ──────────────────────────────────────────────
  const journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
  if (journey) {
    journey.milestones.push(
      {
        status: 'Reverse Pickup Scanned at Buyer Doorstep',
        location: `${shipment.city ? shipment.city.split('->')[1]?.trim() : 'Buyer'} Hub`,
        detail: 'Reverse courier scanned defective item at buyer doorstep. Fast-Track Dispatch on Pickup Scan unlocked.',
        time: new Date()
      },
      {
        status: `Replacement Dispatched on Pickup Scan — ${fwdName} (${fwdAwb})`,
        location: `${shipment.city ? shipment.city.split('->')[0].trim() : 'Supplier'} Warehouse`,
        detail: `Seller dispatched fresh replacement parcel to buyer via ${fwdName}. Tracking ID: ${fwdAwb}. Replacement In-Box QR generated for delivery verification.`,
        time: new Date()
      }
    );
    await journey.save();
  }

  const fmt = (n) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;

  // ── Notifications ──────────────────────────────────────────────────────────
  const receiver = await findReceiverUser(shipment);
  if (receiver) {
    await createNotification(
      receiver._id,
      'local_shipping',
      `Replacement Dispatched — ${fwdName} (${fwdAwb})`,
      `Great news! Under our Fast-Track Replacement guarantee, your replacement parcel has been dispatched via ${fwdName}.\n\n` +
      `📦 Courier: ${fwdName}\n` +
      `🔢 Tracking ID: ${fwdAwb}\n\n` +
      `When the package arrives, scan the Replacement In-Box QR code and enter your SMS OTP to verify delivery and close the replacement order!`,
      'confirmed',
      shipment.shipmentId
    );
  }

  await createNotification(
    shipment.senderId,
    'check_circle',
    `Replacement Dispatched on Pickup Scan — ${shipment.shipmentId}`,
    `Replacement item dispatched via ${fwdName} (${fwdAwb}) under Dispatch on Pickup Scan. Download/print the Replacement In-Box QR label for the parcel.`,
    'confirmed',
    shipment.shipmentId,
    'RETURN_ORDERS'
  );

  return {
    success: true,
    shipment,
    replacementAwbCode:     fwdAwb,
    replacementCarrierName: fwdName,
    replacementQrToken:     repQrToken,
    replacementDeliveryOtp: repOtp,
    message: `Defective parcel pickup verified! Replacement item dispatched via ${fwdName} (AWB: ${fwdAwb}) on Pickup Scan. Replacement In-Box QR label is ready to print.`
  };
};

/**
 * Option 1 — Step 4: Buyer confirms receipt of the replacement item (via In-Box QR / OTP or Portal).
 * Releases original escrow principal to the supplier.
 */
const confirmReplacementDelivery = async (shipmentId, receiverId) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  if (!shipment) throw new Error('Shipment not found');
  if (shipment.returnType !== 'replacement') throw new Error('This shipment is not a replacement return');
  if (!shipment.replacementItemDispatched) {
    throw new Error('Replacement item has not been dispatched yet by the seller');
  }

  const createdDate = shipment.createdAt ? new Date(shipment.createdAt) : new Date();
  const daysHeld = Math.max(1, Math.ceil((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));
  const formattedPrincipal = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;

  const feeCalc = calculateServiceFee(shipment.amount); // fee = 0, escrow is free
  const serviceFee = feeCalc.fee; // 0
  const courierFreight = shipment.courierDeliveryCharge > 0 
    ? shipment.courierDeliveryCharge 
    : (shipment.pickupRate > 0 ? shipment.pickupRate : 55);
  const revCourierFreight = shipment.replacementPickupRate || shipment.returnShippingRate || 45;
  const totalDeductions = parseFloat((serviceFee + courierFreight + revCourierFreight).toFixed(2));
  const netPayout = Math.max(0, parseFloat((shipment.amount - totalDeductions).toFixed(2)));

  shipment.replacementDelivered       = true;
  shipment.replacementDeliveredAt     = new Date();
  shipment.replacementQrUsed          = true;
  shipment.replacementQrConfirmedAt   = new Date();
  shipment.replacementDeliveryOtpUsed = true;
  shipment.returnStatus               = 'Completed';
  shipment.status                     = 'Released';
  shipment.escrowStage                = 6;
  shipment.daysInEscrow               = daysHeld;
  shipment.courierDeliveryCharge      = courierFreight;
  shipment.courierChargeDeducted      = courierFreight + revCourierFreight;
  shipment.courierChargeDeductedFrom  = 'escrow_settlement';
  shipment.courierChargeStatus        = 'Deducted';
  shipment.netSellerPayout            = netPayout;
  shipment.principalDisbursedToSupplier = netPayout;
  shipment.serviceFeeDeducted         = serviceFee;
  shipment.gatewayFeeDeducted         = serviceFee;
  shipment.gatewayFeeRate             = feeCalc.rate;
  shipment.confirmationWindowClosed   = true;
  shipment.withdrawableAt             = new Date();
  await shipment.save();

  const isPaidOffline = shipment.paymentMode === 'paid_offline';
  const receiver = await findReceiverUser(shipment, receiverId);
  const supplier = await User.findById(shipment.senderId);

  if (!isPaidOffline && supplier) {
    supplier.walletBalance = parseFloat(((Number(supplier.walletBalance) || 0) + netPayout).toFixed(2));
    await supplier.save();
  }

  // Add CarrierJourney milestone
  try {
    const CarrierJourney = require('../models/CarrierJourney');
    let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
    if (journey) {
      journey.milestones.push({
        status: 'Replacement Confirmed by Buyer — Escrow Released',
        location: `${shipment.city ? shipment.city.split('->')[1]?.trim() : 'Buyer'} Location`,
        detail: `Buyer confirmed receipt of replacement product. Escrow payment of ${formattedPrincipal} disbursed to seller.`,
        time: new Date()
      });
      await journey.save();
    }
  } catch (jErr) {}

  // Notifications
  if (receiver) {
    await createNotification(
      receiver._id,
      'verified',
      `Replacement Order Complete — ${shipment.shipmentId}`,
      `You confirmed delivery of the replacement product. Your order #${shipment.shipmentId} is successfully completed!`,
      'confirmed',
      shipment.shipmentId
    );
  }

  if (supplier) {
    await createNotification(
      supplier._id,
      'payments',
      `Replacement Completed & Escrow Released — ${shipment.shipmentId}`,
      `Buyer confirmed delivery of the replacement product! Escrow payment of ${formattedPrincipal} has been released to your wallet.`,
      'payment',
      shipment.shipmentId
    );
  }

  return {
    success: true,
    shipment,
    message: `Replacement delivery confirmed! Order successfully completed and escrow payment of ${formattedPrincipal} released to seller.`
  };
};

const rejectReplacement = async (shipmentId, supplierId, rejectReason = 'Supplier unable to fulfil replacement') => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  if (!shipment) throw new Error('Shipment not found');
  if (shipment.returnType !== 'replacement') throw new Error('This shipment is not a replacement return');
  if (shipment.status !== 'Return Requested') throw new Error('Replacement can only be rejected when return is in Requested state');

  shipment.replacementApproved = false;
  shipment.replacementRejectedAt = new Date();
  shipment.returnReason = `Replacement rejected: ${rejectReason}`;
  shipment.returnType = 'full_refund'; // Converts to standard return with reverse pickup
  await shipment.save();

  // Auto-book reverse courier pickup so the product is returned to the supplier
  const approvedShipment = await approveReturnEscrow(shipment.shipmentId, {}, supplierId);

  return { 
    shipment: approvedShipment, 
    outcome: 'replacement_rejected_return_booked',
    message: `Replacement rejected (${rejectReason}). Reverse courier (${approvedShipment.returnCarrierName}) has been auto-booked to collect the product. Full refund will be disbursed once received.`
  };
};

module.exports = {

  releaseEscrow,
  lockEscrow,
  cancelEscrow,
  refundUndeliveredEscrow,
  requestReturnEscrow,
  approveReturnEscrow,
  confirmReturnReceivedEscrow,
  confirmDelivery,
  closeReturnRequest,
  closeReturnWindow,
  checkAndAutoCloseReturnWindow,
  getSupplierMonthlyVolume,
  offerPartialDiscount,
  respondToDiscount,
  approveReplacement,
  dispatchReplacement,
  confirmReplacementDelivery,
  rejectReplacement
};

