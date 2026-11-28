const Shipment = require('../models/Shipment');
const User = require('../models/User');
const Reward = require('../models/Reward');
const WalletTransaction = require('../models/WalletTransaction');
const { createNotification } = require('./notification');
const { calculateServiceFee } = require('../utils/feeConfig');
const { recordTransaction } = require('./walletService');

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

  if (receiverId && shipment.receiverId && shipment.receiverId.toString() !== receiverId.toString()) {
    if (shipment.senderId && shipment.senderId.toString() !== receiverId.toString()) {
      throw new Error('Unauthorized: User is not authorized to release this shipment payment');
    }
  }

  // Authorization check: Verify caller identity matches shipment participant
  if (receiverId && shipment.receiverId && shipment.receiverId.toString() !== receiverId.toString()) {
    if (shipment.senderId && shipment.senderId.toString() !== receiverId.toString()) {
      throw new Error('Unauthorized: User is not authorized to release this shipment payment');
    }
  }

  // Validate shipment state
  if (shipment.escrowStage === 6) {
    throw new Error('Order payment has already been released');
  }

  if (shipment.escrowStage === -1) {
    throw new Error('Order payment is locked due to an active dispute claim');
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
  const codFeeAlreadyPaid = Boolean(shipment.codFeePaid);
  const codHandlingFee = (isCod && !codFeeAlreadyPaid) ? (shipment.codHandlingCharge > 0 ? shipment.codHandlingCharge : 30) : 0;
  const isPaidOffline = shipment.paymentMode === 'paid_offline';

  // In online/escrow and COD modes, courier & COD fees are net-settled from escrow.
  // If the seller already paid the courier freight & COD fee upfront at booking (codFeePaid === true),
  // do NOT deduct it again from the collected cash remittance!
  const freightDeduction = (isPaidOffline || codFeeAlreadyPaid) ? 0 : courierFreight;
  const totalDeductions = parseFloat((serviceFee + freightDeduction + codHandlingFee).toFixed(2));
  let initialNetPayout = Math.max(0, parseFloat((shipment.amount - totalDeductions).toFixed(2)));

  // Find sender and receiver user profiles
  const sender = await User.findById(shipment.senderId);
  const receiver = await findReceiverUser(shipment, receiverId);

  // ── Settle Any Pending RTO Charges from this Settlement ───────────────────
  // If seller previously had undelivered / RTO orders with "Deduct from Settlement",
  // recover those pending return freight charges from this settlement payout.
  let rtoDeductionAmount = 0;
  const recoveredRtoShipments = [];

  if (sender && !isPaidOffline && initialNetPayout > 0) {
    const pendingRtos = await Shipment.find({
      senderId: shipment.senderId,
      status: 'Undelivered',
      rtoSettlementPending: true
    }).sort({ createdAt: 1 });

    let remainingPayout = initialNetPayout;
    for (const rtoShip of pendingRtos) {
      const pendingCharge = Number(rtoShip.undeliveredSupplierCharge) || Number(rtoShip.deliveryCharge) || 40;
      if (pendingCharge <= 0) {
        rtoShip.rtoSettlementPending = false;
        await rtoShip.save();
        continue;
      }
      if (remainingPayout >= pendingCharge) {
        remainingPayout = parseFloat((remainingPayout - pendingCharge).toFixed(2));
        rtoDeductionAmount = parseFloat((rtoDeductionAmount + pendingCharge).toFixed(2));
        rtoShip.rtoSettlementPending = false;
        rtoShip.courierChargeDeductedFrom = 'cod_remittance';
        rtoShip.courierChargeStatus = 'Deducted';
        rtoShip.rtoSettlementDeductedAt = new Date();
        rtoShip.rtoSettlementRecoveredInShipmentId = shipment.shipmentId;
        await rtoShip.save();
        recoveredRtoShipments.push({
          shipmentId: rtoShip.shipmentId,
          awbCode: rtoShip.awbCode || 'N/A',
          amount: pendingCharge
        });
      } else {
        // Payout doesn't fully cover this RTO, keep remaining for next settlement
        break;
      }
    }
    initialNetPayout = remainingPayout;
  }
  const netPayout = initialNetPayout;

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
  shipment.rtoSettlementRecoveredAmount = rtoDeductionAmount;
  shipment.isOverMonthlyThreshold = false;
  shipment.principalDisbursedToSupplier = netPayout;
  shipment.confirmationWindowClosed = true;
  shipment.withdrawableAt = new Date();
  await shipment.save();

  // Credit sender wallet balance if online escrow mode
  if (!isPaidOffline && sender) {
    const balBefore = Number(sender.walletBalance) || 0;
    const updatedSender = await User.findOneAndUpdate(
      { _id: sender._id },
      { $inc: { walletBalance: netPayout } },
      { new: true }
    );
    if (updatedSender) {
      sender.walletBalance = updatedSender.walletBalance;
    }
    try {
      const { recordTransaction } = require('./walletService');
      const rtoNote = rtoDeductionAmount > 0
        ? ` (Net after -₹${rtoDeductionAmount} RTO freight recovered for: ${recoveredRtoShipments.map(s => s.shipmentId).join(', ')})`
        : '';
      await recordTransaction({
        userId: sender._id,
        type: 'credit',
        amount: netPayout,
        source: 'escrow_settlement',
        description: `Order payout released for shipment ${shipment.shipmentId}${rtoNote}`,
        balanceBefore: balBefore,
        balanceAfter: sender.walletBalance,
        metadata: {
          shipmentId: shipment.shipmentId,
          grossAmount: shipment.amount,
          freightDeduction,
          codHandlingFee,
          rtoDeductionAmount,
          recoveredRtoShipments
        }
      });
    } catch (e) {}
  }

  // ── Seller Shipping Cashback disabled ─────────────────────────────────

  // Generate payment summary details
  const formattedAmount = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;
  const formattedNet = `₹${new Intl.NumberFormat('en-IN').format(netPayout)}`;
  const formattedFee = `₹${new Intl.NumberFormat('en-IN').format(serviceFee)}`;

  // Create notifications
  if (sender) {
    // Notify sender that funds are payout-cleared minus courier freight & COD handling only
    const formattedCourier = courierFreight > 0 ? `, Courier Freight: -₹${courierFreight}` : '';
    const formattedCod = codHandlingFee > 0 ? `, COD Handling: -₹${codHandlingFee}` : '';
    const formattedRto = rtoDeductionAmount > 0 ? `, RTO Recovery: -₹${rtoDeductionAmount}` : '';
    let payoutMsg = `Payment of ${formattedNet} for shipment ${shipment.shipmentId} has been released to your wallet (Gross: ${formattedAmount}${formattedCourier}${formattedCod}${formattedRto}). Delivery protection service is FREE — no platform fee deducted.`;
    
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
      `Order Payout Released — ${shipment.shipmentId}`,
      payoutMsg,
      'payment'
    );

    if (recoveredRtoShipments.length > 0) {
      const orderList = recoveredRtoShipments.map(s => `${s.shipmentId} (₹${s.amount})`).join(', ');
      await createNotification(
        sender._id,
        'payments',
        `RTO Charges Deducted from Settlement: -₹${rtoDeductionAmount}`,
        `Pending RTO return freight of ₹${rtoDeductionAmount} for undelivered shipment(s) [${orderList}] was recovered from your settlement payout for shipment ${shipment.shipmentId}.`,
        'payment'
      );
    }
    
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
      `Order Payout Released — ${shipment.shipmentId}`,
      payoutMsg,
      'payment'
    );
    // Instant WhatsApp Notification for Merchant Payout
    try {
      const whatsappService = require('./whatsappService');
      if (whatsappService && whatsappService.sendPayoutReleasedWhatsApp && sender.phone) {
        await whatsappService.sendPayoutReleasedWhatsApp({
          phone: sender.phone,
          senderName: sender.fullName,
          shipmentId: shipment.shipmentId,
          amount: shipment.amount,
          netPayout,
          method: sender.bankDetails?.accountNumber ? `Bank A/C (... ${sender.bankDetails.accountNumber.slice(-4)})` : (sender.bankDetails?.upiId ? `UPI (${sender.bankDetails.upiId})` : 'Wallet Balance')
        });
      }
    } catch (waErr) {
      console.warn('[Payout WhatsApp Notice Warning]:', waErr.message);
    }
  }

  if (receiver) {
    await createNotification(
      receiver._id,
      'verified',
      `Order Settled — ${shipment.shipmentId}`,
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
          const REFERRAL_REWARD = 30;
          const userBefore = await User.findOneAndUpdate(
            { _id: referrer._id },
            { 
              $inc: { 
                walletBalance: REFERRAL_REWARD,
                referralCredits: REFERRAL_REWARD,
                totalReferralEarned: REFERRAL_REWARD
              } 
            },
            { new: false }
          );
          const balBefore = userBefore ? (Number(userBefore.walletBalance) || 0) : 0;
          const balAfter = parseFloat((balBefore + REFERRAL_REWARD).toFixed(2));

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
            `🎉 Refer & Earn: +₹30 Cash Added to Wallet!`,
            `${sender.fullName} (your referral) just completed their first shipment delivery! ` +
            `₹30 cash has been credited directly to your Wallet. You can withdraw it to UPI/Bank or use it to pay for courier shipments.`,
            'reward'
          );

          console.log(`[REFERRAL] ₹30 cash reward added to wallet for ${referrer.fullName} (referred: ${sender.fullName}, shipment: ${shipment.shipmentId})`);
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

  if (claimUser) {
    const claimUserId = claimUser._id ? claimUser._id.toString() : claimUser.toString();
    const isReceiver = shipment.receiverId && shipment.receiverId.toString() === claimUserId;
    const isSender = shipment.senderId && shipment.senderId.toString() === claimUserId;
    const isAdmin = claimUser.role === 'Admin' || claimUser.role === 'super_admin';
    if (!isReceiver && !isSender && !isAdmin) {
      throw new Error('Unauthorized: Only shipment participants or admin can file a dispute claim');
    }
  }

  // Authorization check: Verify caller identity matches shipment participant
  if (receiverId && shipment.receiverId && shipment.receiverId.toString() !== receiverId.toString()) {
    if (shipment.senderId && shipment.senderId.toString() !== receiverId.toString()) {
      throw new Error('Unauthorized: User is not authorized to release this shipment payment');
    }
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
    `The receiver has filed a dispute claim on order payment of ${formattedAmount}. Funds are frozen until resolution.`,
    'alert'
  );

  return shipment;
};

/**
 * Cancels shipment and handles escrow refund if applicable.
 * Also automatically cancels the order in the carrier partner / master account
 * (NimbusPost, Shiprocket, Delhivery Direct, etc.) before courier pickup.
 */
const cancelEscrow = async (shipmentId, userId, reason = 'Cancelled by user') => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  if (!shipment) {
    throw new Error('Shipment not found');
  }

  if (userId) {
    const callerId = userId._id ? userId._id.toString() : userId.toString();
    const isSender = shipment.senderId && (shipment.senderId._id ? shipment.senderId._id.toString() : shipment.senderId.toString()) === callerId;
    const isReceiver = shipment.receiverId && (shipment.receiverId._id ? shipment.receiverId._id.toString() : shipment.receiverId.toString()) === callerId;
    const isAdmin = userId.role === 'Admin' || userId.role === 'super_admin' || userId.isAdmin;
    if (!isSender && !isReceiver && !isAdmin) {
      throw new Error('Unauthorized: User is not authorized to cancel this shipment');
    }
  }

  if (shipment.status === 'Cancelled') {
    throw new Error('Shipment is already cancelled');
  }

  if (shipment.status === 'Released') {
    throw new Error('Cannot cancel a shipment whose order payment has already been released');
  }

  // Prevent cancellation once the package has been dispatched/picked up, delivered, or locked in dispute
  const blockedCancelStatuses = [
    'Cancelled',
    'Released',
    'In Transit',
    'Dispatched',
    'Picked Up',
    'Reached Destination Hub',
    'Out for Delivery',
    'Delivered',
    'Locked',
    'Return Requested',
    'Return In Transit',
    'Replacement In Transit'
  ];
  const isPhysicallyPickedUp = shipment.pickupStatus === 'Picked Up' ||
    blockedCancelStatuses.slice(2).includes(shipment.status);

  if (isPhysicallyPickedUp) {
    throw new Error('Cannot cancel shipment once package has been physically picked up by the carrier. Please file a dispute claim instead.');
  }

  // Atomic state transition BEFORE refunding wallet to defeat TOCTOU concurrent cancel double-refunds
  const wasFunded = shipment.escrowStage >= 2 && !['cod', 'paid_offline'].includes(shipment.paymentMode);
  const atomicCancelled = await Shipment.findOneAndUpdate(
    {
      shipmentId: shipment.shipmentId,
      status: { $nin: blockedCancelStatuses },
      pickupStatus: { $ne: 'Picked Up' }
    },
    {
      $set: {
        status: 'Cancelled',
        escrowStage: -2,
        pickupStatus: 'Cancelled',
        cancelledAt: new Date(),
        cancelReason: reason || 'Cancelled by user',
        ...(wasFunded ? { principalRefundedToReceiver: shipment.amount } : {})
      }
    },
    { new: true }
  );

  if (!atomicCancelled) {
    throw new Error('Shipment is already cancelled or cannot be cancelled in its current state');
  }

  // ── Refund Exact Debited Shipment Charges to Seller Wallet ──
  let refundedAmount = 0;
  let walletBalanceRemaining;
  try {
    // 1. Idempotency guard: check if this shipment was already refunded in the wallet ledger
    const existingRefund = await WalletTransaction.findOne({
      type: 'credit',
      source: 'cancelled_shipment_freight_refund',
      status: 'success',
      'metadata.shipmentId': shipment.shipmentId
    }).lean();

    if (!existingRefund && shipment.senderId) {
      // 2. Query exact wallet debit entries for this shipmentId from WalletTransaction ledger
      const debitTxs = await WalletTransaction.find({
        userId: shipment.senderId,
        type: 'debit',
        status: 'success',
        source: { $in: ['cod_fee_deduction', 'shipping_fee_deduction', 'reverse_shipping_fee_deduction', 'freight_deduction'] },
        $or: [
          { 'metadata.shipmentId': shipment.shipmentId },
          { description: new RegExp(`\\b${shipment.shipmentId}\\b`, 'i') }
        ]
      }).lean();

      const ledgerDebitedAmount = parseFloat(
        debitTxs.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0).toFixed(2)
      );

      // 3. Fallback calculation from Shipment fields if ledger entry is missing
      let shipmentFieldAmount = 0;
      if (shipment.codFeePaid && shipment.codFeePaymentMethod === 'wallet_adjustment' && Number(shipment.codUpfrontFee) > 0) {
        shipmentFieldAmount += Number(shipment.codUpfrontFee);
      }
      if (shipment.courierChargeStatus === 'Deducted' && Number(shipment.courierChargeDeducted) > 0) {
        shipmentFieldAmount += Number(shipment.courierChargeDeducted);
      } else if (shipment.isReverse && shipment.returnShippingChargeStatus === 'Deducted' && Number(shipment.returnShippingChargeDeducted) > 0) {
        shipmentFieldAmount += Number(shipment.returnShippingChargeDeducted);
      }
      shipmentFieldAmount = parseFloat(shipmentFieldAmount.toFixed(2));

      // Exact debited amount from wallet ledger takes priority
      const refundToSeller = ledgerDebitedAmount > 0 ? ledgerDebitedAmount : shipmentFieldAmount;

      if (shipment.codFeePaid && shipment.codFeePaymentMethod === 'wallet_adjustment') {
        shipment.codFeePaid = false;
      }
      if (shipment.courierChargeStatus === 'Deducted') {
        shipment.courierChargeStatus = 'Refunded';
      }
      if (shipment.returnShippingChargeStatus === 'Deducted') {
        shipment.returnShippingChargeStatus = 'Refunded';
      }

      if (refundToSeller > 0) {
        const updatedSender = await User.findOneAndUpdate(
          { _id: shipment.senderId },
          { $inc: { walletBalance: refundToSeller } },
          { new: true }
        );
        if (updatedSender) {
          const balAfter = parseFloat(Number(updatedSender.walletBalance).toFixed(2));
          const balBefore = parseFloat((balAfter - refundToSeller).toFixed(2));
          if (balAfter !== updatedSender.walletBalance) {
            await User.updateOne({ _id: updatedSender._id }, { $set: { walletBalance: balAfter } });
          }

          refundedAmount = refundToSeller;
          walletBalanceRemaining = balAfter;

          await recordTransaction({
            userId: updatedSender._id,
            type: 'credit',
            amount: refundToSeller,
            source: 'cancelled_shipment_freight_refund',
            description: `Refund for cancelled shipment ${shipment.shipmentId} courier & upfront charges`,
            paymentGateway: 'system',
            balanceBefore: balBefore,
            balanceAfter: balAfter,
            metadata: { shipmentId: shipment.shipmentId, refundedAmount: refundToSeller }
          });
        }
      }
    }
  } catch (refundErr) {
    console.warn(`[SELLER FREIGHT REFUND WARNING] for ${shipmentId}:`, refundErr.message);
  }

  // Persist refunded charge flags on the already-cancelled shipment
  await Shipment.updateOne(
    { _id: shipment._id },
    {
      $set: {
        codFeePaid: shipment.codFeePaid,
        courierChargeStatus: shipment.courierChargeStatus,
        returnShippingChargeStatus: shipment.returnShippingChargeStatus
      }
    }
  );
  shipment.status = 'Cancelled';
  shipment.escrowStage = -2;
  shipment.pickupStatus = 'Cancelled';
  shipment.cancelledAt = atomicCancelled.cancelledAt;
  shipment.cancelReason = atomicCancelled.cancelReason;

  // ── Background Side Effects: Courier API Cancel, Journey Timeline & Notifications ──
  // Run asynchronously so the cancellation API responds instantaneously without waiting on external courier APIs
  const shipmentSnapshot = shipment.toObject();
  const formattedAmount = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;
  setImmediate(() => {
    (async () => {
      try {
        const { cancelCarrierShipment } = require('./pickupService');
        await cancelCarrierShipment(shipmentSnapshot);
      } catch (carrierErr) {
        console.warn(`[CARRIER DISPATCH CANCEL WARNING] Could not cancel carrier for ${shipmentId}:`, carrierErr.message);
      }

      try {
        const CarrierJourney = require('../models/CarrierJourney');
        const journey = await CarrierJourney.findOne({ shipmentId: shipmentSnapshot.shipmentId });
        if (journey) {
          journey.milestones.push({
            status: 'Cancelled',
            location: shipmentSnapshot.city || 'Origin Location',
            detail: `Shipment cancelled before courier pickup (${reason || 'Cancelled by user'}). Master account courier booking cancelled.`,
            time: new Date()
          });
          await journey.save();
        }
      } catch (jErr) {
        console.warn('[CARRIER JOURNEY CANCEL NOTE]:', jErr.message);
      }

      try {
        await createNotification(
          shipmentSnapshot.senderId,
          'cancel',
          `Shipment Cancelled: ${shipmentSnapshot.shipmentId}`,
          `Order ${shipmentSnapshot.shipmentId} was cancelled. ${wasFunded ? `Payment deposit of ${formattedAmount} refunded.` : ''} Reason: ${reason}`,
          'alert'
        );

        const receiver = await findReceiverUser(shipmentSnapshot, userId);
        if (receiver) {
          await createNotification(
            receiver._id,
            'cancel',
            `Shipment Cancelled: ${shipmentSnapshot.shipmentId}`,
            `Order ${shipmentSnapshot.shipmentId} was cancelled (${reason}). If you made any advance payment directly to the merchant outside the platform, please contact the seller for your settlement or raise a dispute claim.`,
            'alert'
          );
        }
      } catch (notifErr) {
        console.warn('[CANCEL NOTIFICATION NOTE]:', notifErr.message);
      }
    })();
  });

  return {
    ...shipmentSnapshot,
    refundedAmount,
    ...(walletBalanceRemaining !== undefined ? { walletBalanceRemaining } : {})
  };
};

/**
 * Refunds escrow principal to Receiver for undelivered courier shipments.
 * Zero penalties / deductions applied (100% principal refunded to receiver).
 */
const refundUndeliveredEscrow = async (shipmentId, reason = 'Carrier reported delivery failed / undelivered', callerId = null) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
  
  if (!shipment) {
    throw new Error('Shipment not found');
  }

  // Authorization check: Verify caller identity matches shipment participant if callerId provided
  if (callerId && shipment.receiverId && shipment.receiverId.toString() !== callerId.toString()) {
    if (shipment.senderId && shipment.senderId.toString() !== callerId.toString()) {
      throw new Error('Unauthorized: User is not authorized to release this shipment payment');
    }
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

  // Courier partner bills SecureKaro for the return freight (RTO).
  const rtoFreightCharge = Number(shipment.deliveryCharge) || 40;

  const shouldDeductFromSettlement = Boolean(
    shipment.rtoDeductFromSettlement ||
    shipment.deductFromSettlement ||
    shipment.codFeePaymentMethod === 'deduct_from_cod' ||
    shipment.codFeePaymentMethod === 'settlement_deduction'
  );

  // Platform does not collect or hold parcel payment; refund of parcel principal is settled directly with seller
  const supplierRelief = 0;
  const receiverPenalty = 0;
  const receiverRefund = 0;
  const supplierBuyerPenaltyShare = 0;
  const receiverWeeklyRejectionCount = 0;

  // Calculate days held
  const createdDate = shipment.createdAt ? new Date(shipment.createdAt) : new Date();
  const daysHeld = Math.max(1, Math.ceil((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));

  // Persist undelivered status on the shipment record
  shipment.status = 'Undelivered';
  shipment.escrowStage = -3;
  shipment.daysInEscrow = daysHeld;
  shipment.undeliveredSupplierRelief = 0;
  shipment.undeliveredSupplierPenalty = 0;
  shipment.undeliveredSupplierCharge = rtoFreightCharge;
  shipment.undeliveredReceiverPenalty = 0;
  shipment.undeliveredPlatformCharge = 0;
  shipment.principalRefundedToReceiver = 0;
  shipment.undeliveredReason = reason;
  shipment.undeliveredProcessedAt = new Date();

  if (shouldDeductFromSettlement) {
    shipment.rtoDeductFromSettlement = true;
    shipment.rtoSettlementPending = true;
    shipment.courierChargeDeductedFrom = 'pending_recovery';
    shipment.courierChargeStatus = 'Pending';
  } else {
    shipment.courierChargeDeductedFrom = 'seller_wallet';
    shipment.courierChargeStatus = 'Deducted';
  }
  await shipment.save();

  // ── Format helpers ─────────────────────────────────────────────────────────
  const fmt = (n) => `₹${new Intl.NumberFormat('en-IN').format(n)}`;

  // ── Notify receiver about undelivered package ───────
  const receiver = await findReceiverUser(shipment);
  if (receiver) {
    await createNotification(
      receiver._id,
      'local_shipping',
      `Shipment Undelivered: ${shipment.shipmentId}`,
      `Shipment ${shipment.shipmentId} was marked undelivered by courier (${reason}). If you paid the merchant directly in advance, please request your refund directly from the seller or file a dispute claim.`,
      'shipping'
    );
  }

  // ── Handle supplier wallet & notifications ─────────────────────────────────
  const supplier = await User.findById(shipment.senderId);
  if (supplier) {
    if (shouldDeductFromSettlement) {
      // Do NOT deduct immediately from wallet! Queued for deduction from upcoming order settlements
      const currentBal = Number(supplier.walletBalance) || 0;
      await recordTransaction({
        userId: supplier._id,
        type: 'debit',
        amount: 0,
        source: 'rto_freight',
        description: `RTO return freight (₹${rtoFreightCharge}) queued for deduction from upcoming order settlements for undelivered shipment ${shipment.shipmentId} (AWB: ${shipment.awbCode || 'N/A'})`,
        paymentGateway: 'settlement_adjustment',
        balanceBefore: currentBal,
        balanceAfter: currentBal,
        metadata: {
          shipmentId: shipment.shipmentId,
          awbCode: shipment.awbCode,
          reason,
          rtoFreightCharge,
          deductFromSettlement: true,
          status: 'pending_settlement_deduction'
        }
      });

      await createNotification(
        supplier._id,
        'local_shipping',
        `RTO Return Freight Queued for Settlement: ${fmt(rtoFreightCharge)} (${shipment.shipmentId})`,
        `Courier marked shipment ${shipment.shipmentId} as undelivered / RTO (${reason}). Return freight of ${fmt(rtoFreightCharge)} will be automatically deducted from your upcoming delivered order settlements instead of your wallet balance. The parcel is returning to your pickup address.`,
        'payment'
      );
    } else {
      // Deduct RTO return freight from seller's wallet atomically
      const supplierBefore = await User.findOneAndUpdate(
        { _id: supplier._id },
        { $inc: { walletBalance: -rtoFreightCharge } },
        { new: false }
      );
      const balBefore = supplierBefore ? parseFloat((Number(supplierBefore.walletBalance) || 0).toFixed(2)) : 0;
      const balAfter = parseFloat((balBefore - rtoFreightCharge).toFixed(2));

      await recordTransaction({
        userId: supplier._id,
        type: 'debit',
        amount: rtoFreightCharge,
        source: 'rto_freight',
        description: `RTO return freight charged by courier for undelivered shipment ${shipment.shipmentId} (AWB: ${shipment.awbCode || 'N/A'})`,
        paymentGateway: 'system',
        balanceBefore: balBefore,
        balanceAfter: balAfter,
        metadata: {
          shipmentId: shipment.shipmentId,
          awbCode: shipment.awbCode,
          reason,
          rtoFreightCharge
        }
      });

      await createNotification(
        supplier._id,
        'local_shipping',
        `RTO Return Freight: -${fmt(rtoFreightCharge)} (${shipment.shipmentId})`,
        `Courier marked shipment ${shipment.shipmentId} as undelivered / RTO (${reason}). Return freight of ${fmt(rtoFreightCharge)} was deducted from your wallet reserve. The parcel is returning to your pickup address.`,
        'payment'
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

  // Authorization check: Verify caller identity matches shipment participant
  if (receiverId && shipment.receiverId && shipment.receiverId.toString() !== receiverId.toString()) {
    if (shipment.senderId && shipment.senderId.toString() !== receiverId.toString()) {
      throw new Error('Unauthorized: User is not authorized to release this shipment payment');
    }
  }

  if (shipment.status === 'Released') {
    throw new Error('Cannot request return after order payment has been released');
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
    full_refund: `Buyer applied for a FULL REFUND for parcel #${shipment.shipmentId} (Reason: ${reason}). Please assign the reverse courier partner & tracking ID in Return Orders. Order payment of ${formattedAmount} is frozen.`,
    replacement: `Buyer applied for a REPLACEMENT for parcel #${shipment.shipmentId} (Reason: ${reason}). Please review and approve/reject this request in Return Orders. Order payment of ${formattedAmount} is frozen.`,
    partial_discount: `Buyer applied for a PARTIAL DISCOUNT/REFUND for parcel #${shipment.shipmentId} (Reason: ${reason}). Buyer uploaded defect photo — review it in Return Orders and set a discount offer price. Order payment of ${formattedAmount} is frozen.`
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

  // Authorization check: Verify caller identity matches shipment supplier/sender
  if (supplierId && shipment.senderId && shipment.senderId.toString() !== supplierId.toString()) {
    throw new Error('Unauthorized: Only the shipment supplier can approve this return');
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
    const rateResult = getCheapestPickupCarrier(fromPincode, toPincode, weightKg, dims, true);
    const cheapest = rateResult.cheapest;
    carrierSlug = cheapest.slug;
    carrierName = cheapest.name;
    shippingRate = cheapest.price;
    savingsAmount = rateResult.savingsAmount;
    comparison = rateResult.comparison;
    isAutoBooked = true;
  } else {
    carrierName = courierData.carrierName || (carrierSlug ? carrierSlug.toUpperCase() + ' Express' : 'Delhivery Express');
    const { getCarrierRates } = require('./carrierRateService');
    const allQuotes = getCarrierRates(fromPincode, toPincode, weightKg, dims, true);
    const matched = allQuotes.find(q => q.slug === carrierSlug);
    shippingRate = matched ? matched.price : (courierData.shippingRate || 55);
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
  shipment.returnShippingChargePaidBy = 'seller';
  shipment.returnShippingChargeStatus = 'Pending';
  shipment.returnShippingChargeDeducted = shippingRate;
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
      status: 'Reverse Courier Auto-Booked (Doorstep QC & Pickup)',
      location: `${shipment.city || 'Buyer City'} Pickup Hub`,
      detail: `Reverse courier automatically booked with ${carrierName} at lowest reverse rate ₹${shippingRate || 55}${savingsAmount ? ` (Saved ₹${savingsAmount} via multi-carrier comparison)` : ''}. Reverse AWB: ${trackingId}. Scheduled Pickup Window: ${pickupWindow}. Reverse shipping fee will be charged to the seller on return receipt.`,
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

  // 2. Notify Supplier confirming auto-booking & cost
  if (shipment.senderId) {
    await createNotification(
      shipment.senderId,
      'check_circle',
      `Reverse Courier Auto-Booked — ${shipment.shipmentId}`,
      `Reverse courier ${carrierName} auto-booked at lowest reverse shipping rate (₹${shippingRate || 55}${savingsAmount ? `, saved ₹${savingsAmount}` : ''}). Tracking ID: ${trackingId}. Scheduled pickup: ${pickupWindow}. Note: As per platform policy, the reverse shipping fee of ₹${shippingRate || 55} is charged to your seller account upon return delivery confirmation.`,
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
const confirmReturnReceivedEscrow = async (shipmentId, callerId = null) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });

  if (!shipment) {
    throw new Error('Shipment not found');
  }

  if (shipment.returnStatus === 'Returned & Refunded' || shipment.status === 'Returned & Refunded') {
    throw new Error('Return receipt has already been confirmed and refunded');
  }

  // Authorization check: Verify caller identity matches shipment supplier/sender
  if (callerId && shipment.senderId && shipment.senderId.toString() !== callerId.toString()) {
    throw new Error('Unauthorized: Only the shipment supplier can confirm return receipt');
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
      const balBefore = Number(supplier.walletBalance) || 0;
      const updatedSupplier = await User.findOneAndUpdate(
        { _id: supplier._id },
        { $inc: { walletBalance: netPayout } },
        { new: true }
      );
      if (updatedSupplier) {
        supplier.walletBalance = updatedSupplier.walletBalance;
      }
      try {
        const { recordTransaction } = require('./walletService');
        await recordTransaction({
          userId: supplier._id,
          type: 'credit',
          amount: netPayout,
          source: 'escrow_settlement',
          description: `Replacement order payout for shipment ${shipment.shipmentId}`,
          balanceBefore: balBefore,
          balanceAfter: supplier.walletBalance,
          metadata: { shipmentId: shipment.shipmentId }
        });
      } catch (e) {}
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
      // Escrow / Prepaid: Notify supplier of payout (credit already applied atomically above)
      if (supplier) {
        await createNotification(
          supplier._id,
          'payments',
          `Replacement Complete: Payment Released — ${shipment.shipmentId}`,
          `Defective item for ${shipment.shipmentId} arrived at your warehouse. Replacement complete! Principal (${formattedPrincipal}) has been credited to your wallet.`,
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
      message: `Old item received! Replacement complete and payment of ${formattedPrincipal} disbursed to supplier.`
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
    if (supplier && receiver) {
      const updatedSupplier = await User.findOneAndUpdate(
        { _id: supplier._id, walletBalance: { $gte: principalNum } },
        { $inc: { walletBalance: -principalNum } },
        { new: true }
      );

      if (updatedSupplier) {
        await User.findOneAndUpdate(
          { _id: receiver._id },
          { $inc: { walletBalance: principalNum } }
        );

        await createNotification(
          receiver._id,
          'payments',
          `Return Processed: Refund Credited — ${shipment.shipmentId}`,
          `Returned parcel ${shipment.shipmentId} arrived at supplier. Refund of ${formattedPrincipal} has been adjusted from supplier and credited to your wallet.`,
          'payment',
          shipment.shipmentId
        );
      }
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
      await createNotification(
        receiver._id,
        'local_shipping',
        `Return Delivered to Seller: ${shipment.shipmentId}`,
        `Returned parcel ${shipment.shipmentId} was received at the seller's warehouse. If you paid the merchant directly in advance, please ensure the seller settles your refund or raise a dispute claim.`,
        'shipping',
        shipment.shipmentId
      );
    }

    if (supplier) {
      await createNotification(
        supplier._id,
        'wallet',
        `Return Complete: Package Received — ${shipment.shipmentId}`,
        `Returned package ${shipment.shipmentId} arrived at your warehouse. Please settle the buyer's refund directly if paid in advance.`,
        'confirmed',
        shipment.shipmentId
      );
    }
  }

  // Instant WhatsApp Notification for Return Refund
  try {
    const whatsappService = require('./whatsappService');
    const targetPhone = shipment.receiverPhone || (receiver && receiver.phone);
    if (whatsappService && whatsappService.sendRefundWhatsApp && targetPhone) {
      await whatsappService.sendRefundWhatsApp({
        phone: targetPhone,
        receiverName: shipment.receiverName || (receiver && receiver.fullName),
        shipmentId: shipment.shipmentId,
        amount: shipment.amount,
        isPartial: false,
        reason: 'Returned package received and verified by seller'
      });
    }
  } catch (waErr) {
    console.warn('[WHATSAPP REFUND Note]:', waErr.message);
  }

  // ── Reverse Shipping Fee Deduction (Seller Pays Policy) ───────────────────
  // In Indian e-commerce (Amazon, Meesho, etc.), reverse courier freight is charged
  // to the seller upon return receipt and debited from the seller's wallet/settlement.
  const revCourierFreight = Number(shipment.returnShippingRate) > 0 
    ? Number(shipment.returnShippingRate) 
    : 55;

  shipment.returnShippingChargeDeducted = revCourierFreight;
  shipment.returnShippingChargePaidBy = 'seller';
  shipment.returnShippingChargeStatus = 'Deducted';
  shipment.returnShippingChargeDeductedFrom = 'seller_wallet';
  shipment.returnShippingChargeDeductedAt = new Date();
  await shipment.save();

  if (supplier) {
    const supplierBefore = await User.findOneAndUpdate(
      { _id: supplier._id },
      { $inc: { walletBalance: -revCourierFreight } },
      { new: false }
    );
    const balBefore = supplierBefore ? (Number(supplierBefore.walletBalance) || 0) : 0;
    const balAfter = parseFloat((balBefore - revCourierFreight).toFixed(2));

    try {
      const { recordTransaction } = require('./walletService');
      await recordTransaction({
        userId: supplier._id,
        type: 'debit',
        amount: revCourierFreight,
        source: 'freight_deduction',
        description: `Reverse courier shipping fee deducted for returned shipment ${shipment.shipmentId} (${shipment.returnCarrierName || 'Courier'} - AWB: ${shipment.returnAwbCode || 'N/A'})`,
        balanceBefore: balBefore,
        balanceAfter: balAfter,
        metadata: {
          shipmentId: shipment.shipmentId,
          returnAwbCode: shipment.returnAwbCode,
          carrier: shipment.returnCarrierName,
          feeType: 'reverse_shipping_fee'
        }
      });
    } catch (txErr) {
      console.warn('[confirmReturnReceivedEscrow] Wallet debit log warning:', txErr.message);
    }

    const formattedRevFreight = `₹${revCourierFreight}`;
    await createNotification(
      supplier._id,
      'wallet',
      `Return Processed: Reverse Shipping Deducted — ${shipment.shipmentId}`,
      `Returned package ${shipment.shipmentId} arrived at your warehouse. Refund of ${formattedPrincipal} processed to buyer. Reverse courier shipping fee of ${formattedRevFreight} (${shipment.returnCarrierName || 'Courier'} - AWB: ${shipment.returnAwbCode || 'N/A'}) has been charged and deducted from your seller wallet.`,
      'confirmed',
      shipment.shipmentId,
      'RETURN_ORDERS'
    );
  }

  // Add CarrierJourney milestone
  try {
    const CarrierJourney = require('../models/CarrierJourney');
    let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
    if (journey) {
      journey.milestones.push({
        status: 'Return Received & Settled',
        location: `${shipment.city ? shipment.city.split('->')[0].trim() : 'Supplier'} Warehouse`,
        detail: `Returned package inspected and received at supplier warehouse. Principal (${formattedPrincipal}) refunded to buyer. Reverse shipping fee (₹${revCourierFreight}) charged to seller.`,
        time: new Date()
      });
      await journey.save();
    }
  } catch (jErr) {}

  return {
    shipment,
    refundSummary: {
      daysHeld,
      receiverPrincipalRefund: shipment.amount,
      reverseShippingChargedToSeller: revCourierFreight,
      sellerWalletBalance: supplier ? supplier.walletBalance : undefined
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

  // Authorization check: Verify caller identity matches shipment participant
  if (receiverId && shipment.receiverId && shipment.receiverId.toString() !== receiverId.toString()) {
    if (shipment.senderId && shipment.senderId.toString() !== receiverId.toString()) {
      throw new Error('Unauthorized: User is not authorized to release this shipment payment');
    }
  }

  // Check if parcel delivery has already been confirmed (either with window closed or open)
  if (shipment.deliveryConfirmed || shipment.status === 'Released') {
    const isClosed = shipment.returnWindowClosed || shipment.status === 'Released' || shipment.returnWindowChoice === 'ImmediateClose';
    const isExpired = shipment.returnWindowExpiresAt && new Date() >= new Date(shipment.returnWindowExpiresAt);
    const windowDetail = isClosed
      ? 'Return window is closed and order payment has been released.'
      : isExpired
        ? 'The 24-hour return window has expired.'
        : `24-hour return window is currently active until ${new Date(shipment.returnWindowExpiresAt).toLocaleString('en-IN')}.`;
    throw new Error(`Parcel already confirmed. ${windowDetail}`);
  }

  if (shipment.escrowStage === -1 || shipment.status === 'Locked') {
    throw new Error('Cannot confirm parcel while payment is locked under an active dispute claim');
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
        detail: 'Receiver confirmed delivery and closed the return window. Payment released to supplier.',
        time: new Date()
      });
      await journey.save();
    }

    return {
      shipment: result.shipment,
      settlement: result.settlement,
      message: 'Parcel confirmed and return window closed. Payment released successfully!'
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

  // Instant WhatsApp Notification for Parcel Delivery Confirmation
  try {
    const whatsappService = require('./whatsappService');
    const targetPhone = shipment.receiverPhone || (receiver && receiver.phone);
    if (whatsappService && whatsappService.sendDeliveredWhatsApp && targetPhone) {
      await whatsappService.sendDeliveredWhatsApp({
        phone: targetPhone,
        receiverName: shipment.receiverName || (receiver && receiver.fullName),
        shipmentId: shipment.shipmentId,
        returnAllowed: Boolean(shipment.returnAllowed),
        returnWindowHours: 24
      });
    }
  } catch (waErr) {
    console.warn('[WHATSAPP DELIVERED Note]:', waErr.message);
  }

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

  // Authorization check: Verify caller identity matches shipment participant
  if (receiverId && shipment.receiverId && shipment.receiverId.toString() !== receiverId.toString()) {
    if (shipment.senderId && shipment.senderId.toString() !== receiverId.toString()) {
      throw new Error('Unauthorized: User is not authorized to release this shipment payment');
    }
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
      message: 'Return request closed. 24-hour return window had expired, so order funds have now been released.'
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
      `You closed the return request for parcel #${shipment.shipmentId}. Payment remains protected until return window conclusion.`,
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

  // Authorization check: Verify caller identity matches shipment participant
  if (receiverId && shipment.receiverId && shipment.receiverId.toString() !== receiverId.toString()) {
    if (shipment.senderId && shipment.senderId.toString() !== receiverId.toString()) {
      throw new Error('Unauthorized: User is not authorized to release this shipment payment');
    }
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
    message: 'Return window closed early. Order funds released to supplier successfully!'
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
      await User.findOneAndUpdate(
        { _id: receiver._id },
        { $inc: { walletBalance: buyerCredit } }
      );
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

      // Instant WhatsApp Notification for Partial Refund Credited
      try {
        const whatsappService = require('./whatsappService');
        const targetPhone = shipment.receiverPhone || (receiver && receiver.phone);
        if (whatsappService && whatsappService.sendRefundWhatsApp && targetPhone) {
          await whatsappService.sendRefundWhatsApp({
            phone: targetPhone,
            receiverName: shipment.receiverName || (receiver && receiver.fullName),
            shipmentId: shipment.shipmentId,
            amount: buyerCredit,
            isPartial: true,
            reason: 'Seller approved partial discount/refund'
          });
        }
      } catch (waErr) {
        console.warn('[WHATSAPP PARTIAL REFUND Note]:', waErr.message);
      }
    }

    const supplier = await User.findById(shipment.senderId);
    if (supplier) {
      await User.findOneAndUpdate(
        { _id: supplier._id },
        { $inc: { walletBalance: supplierCredit } }
      );
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
      dims,
      true
    );
    revSlug = revRate.cheapest.slug;
    revName = revRate.cheapest.name;
    revPickupRate = revRate.cheapest.price || 55;
  } else {
    revName = revName || 'Delhivery Express';
    revPickupRate = 58;
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
      `Once the seller receives and inspects the returned item at their warehouse, your new replacement item will be dispatched. Your payment remains 100% protected.`,
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
  // ── Replacement Dispatch: No photo required, no return QR code generated ──
  shipment.oldItemReceivedBySupplier     = true;
  shipment.oldItemReceivedAt             = shipment.oldItemReceivedAt || new Date();
  shipment.replacementItemDispatched     = true;
  shipment.replacementItemDispatchedAt   = new Date();
  shipment.replacementCarrierSlug        = fwdSlug;
  shipment.replacementCarrierName        = fwdName;
  shipment.replacementAwbCode            = fwdAwb;
  shipment.replacementQrToken            = ''; // No return QR code generated for replacement parcel
  shipment.replacementQrUsed             = true;
  shipment.returnAllowed                 = false; // Final resolution - no secondary return
  shipment.photoReviewEnabled            = false; // No photo required for replacement parcel
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

  // Instant WhatsApp Notification for Replacement Dispatched
  try {
    const whatsappService = require('./whatsappService');
    const targetPhone = shipment.receiverPhone || (receiver && receiver.phone);
    if (whatsappService && whatsappService.sendReplacementBookedWhatsApp && targetPhone) {
      await whatsappService.sendReplacementBookedWhatsApp({
        phone: targetPhone,
        receiverName: shipment.receiverName || (receiver && receiver.fullName),
        shipmentId: shipment.shipmentId,
        carrierName: fwdName,
        awbCode: fwdAwb,
        trackUrl: `https://securekaro.in/tracking?id=${shipment.shipmentId}`
      });
    }
  } catch (waErr) {
    console.warn('[WHATSAPP REPLACEMENT Note]:', waErr.message);
  }

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
  shipment.returnShippingChargeDeducted = revCourierFreight;
  shipment.returnShippingChargePaidBy = 'seller';
  shipment.returnShippingChargeStatus = 'Deducted';
  shipment.returnShippingChargeDeductedFrom = 'escrow_settlement';
  shipment.returnShippingChargeDeductedAt = new Date();
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
    await User.findOneAndUpdate(
      { _id: supplier._id },
      { $inc: { walletBalance: netPayout } }
    );
  }

  // Add CarrierJourney milestone
  try {
    const CarrierJourney = require('../models/CarrierJourney');
    let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
    if (journey) {
      journey.milestones.push({
        status: 'Replacement Confirmed by Buyer — Payment Released',
        location: `${shipment.city ? shipment.city.split('->')[1]?.trim() : 'Buyer'} Location`,
        detail: `Buyer confirmed receipt of replacement product. Payment of ${formattedPrincipal} disbursed to seller.`,
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
      `Replacement Completed & Payment Released — ${shipment.shipmentId}`,
      `Buyer confirmed delivery of the replacement product! Payment of ${formattedPrincipal} has been released to your wallet.`,
      'payment',
      shipment.shipmentId
    );
  }

  return {
    success: true,
    shipment,
    message: `Replacement delivery confirmed! Order successfully completed and payment of ${formattedPrincipal} released to seller.`
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

