const Shipment = require('../models/Shipment');
const User = require('../models/User');
const { createNotification } = require('./notification');

/**
 * Handles release of escrowed funds.
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

  // Release the escrow funds
  shipment.status = 'Released';
  shipment.escrowStage = 6;
  await shipment.save();

  // Find sender and receiver user profiles
  const sender = await User.findById(shipment.senderId);
  const receiver = await User.findById(receiverId);

  // Generate payment summary details
  const formattedAmount = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;

  // Create notifications
  if (sender) {
    // Notify sender that funds are payout-cleared
    let payoutMsg = `Payment of ${formattedAmount} for shipment ${shipment.shipmentId} has been released by the receiver.`;
    if (sender.bankDetails && sender.bankDetails.accountNumber) {
      payoutMsg += ` Funds queued for transfer to A/C ending in ...${sender.bankDetails.accountNumber.slice(-4)}.`;
    } else {
      payoutMsg += ` Warning: Add bank payout details to your profile to claim these funds.`;
    }
    
    await createNotification(
      sender._id,
      'payments',
      'Escrow Funds Released',
      payoutMsg,
      'payment'
    );
  }

  if (receiver) {
    await createNotification(
      receiver._id,
      'verified',
      'Escrow Released Successfully',
      `You confirmed receipt of shipment ${shipment.shipmentId}. ${formattedAmount} has been disbursed to the supplier.`,
      'confirmed'
    );
  }

  return shipment;
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

  // Find Receiver if exists
  const receiver = await User.findOne({ phone: shipment.receiverPhone });
  if (receiver) {
    await createNotification(
      receiver._id,
      'cancel',
      `Shipment Cancelled: ${shipment.shipmentId}`,
      `Escrow order ${shipment.shipmentId} (${formattedAmount}) was cancelled. Reason: ${reason}`,
      'alert'
    );
  }

  return shipment;
};

/**
 * Refunds escrow principal + 5.0% p.a. accrued interest to Receiver for undelivered courier shipments.
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

  // Calculate days held & 5.0% annual interest accrued
  const createdDate = shipment.createdAt ? new Date(shipment.createdAt) : new Date();
  const daysHeld = Math.max(1, Math.ceil((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));
  const annualInterestRate = 0.05; // 5.0% p.a.
  const accruedInterest = parseFloat(((shipment.amount * annualInterestRate * daysHeld) / 365).toFixed(2));
  const totalRefundAmount = parseFloat((shipment.amount + accruedInterest).toFixed(2));

  shipment.status = 'Undelivered';
  shipment.escrowStage = -3;
  await shipment.save();

  const formattedPrincipal = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;
  const formattedInterest = `₹${new Intl.NumberFormat('en-IN').format(accruedInterest)}`;
  const formattedTotal = `₹${new Intl.NumberFormat('en-IN').format(totalRefundAmount)}`;

  // Find receiver to credit refund + interest
  const receiver = await User.findOne({ phone: shipment.receiverPhone });
  if (receiver) {
    await createNotification(
      receiver._id,
      'payments',
      `Delivery Failed: Escrow Refunded + Interest — ${shipment.shipmentId}`,
      `Shipment ${shipment.shipmentId} was undelivered. Escrow principal (${formattedPrincipal}) + accrued interest (${formattedInterest} @ 5% p.a. for ${daysHeld} days) totaling ${formattedTotal} has been refunded to your account.`,
      'payment'
    );
  }

  // Notify sender (supplier)
  await createNotification(
    shipment.senderId,
    'local_shipping',
    `Shipment Undelivered: ${shipment.shipmentId}`,
    `Carrier marked shipment ${shipment.shipmentId} as undelivered (${reason}). Escrow deposit (${formattedPrincipal}) + interest refunded to receiver.`,
    'alert'
  );

  return {
    shipment,
    refundSummary: {
      principal: shipment.amount,
      accruedInterest,
      daysHeld,
      totalRefundAmount
    }
  };
};

/**
 * Initiates a return request, freezes escrow, and generates a Reverse AWB (REV-SPL-XXXX).
 */
const requestReturnEscrow = async (shipmentId, receiverId, reason = 'Product issue / Return requested') => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });

  if (!shipment) {
    throw new Error('Shipment not found');
  }

  if (shipment.status === 'Released') {
    throw new Error('Cannot request return after escrow funds have been released');
  }

  if (['Cancelled', 'Returned & Refunded'].includes(shipment.status)) {
    throw new Error(`Shipment is already ${shipment.status.toLowerCase()}`);
  }

  // Generate Reverse AWB Code
  const returnAwbCode = `REV-${shipment.shipmentId}`;
  const returnCarrierSlug = shipment.carrierSlug || 'delhivery-reverse';
  const returnLabelUrl = `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`;

  shipment.returnStatus = 'Requested';
  shipment.returnAwbCode = returnAwbCode;
  shipment.returnCarrierSlug = returnCarrierSlug;
  shipment.returnReason = reason;
  shipment.returnShippingLabelUrl = returnLabelUrl;
  shipment.status = 'Return Requested';
  shipment.escrowStage = -4;

  await shipment.save();

  // Add Reverse Milestone to CarrierJourney
  const CarrierJourney = require('../models/CarrierJourney');
  let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
  if (journey) {
    journey.milestones.push({
      status: 'Reverse Return Requested',
      location: 'Receiver Address',
      detail: `Return requested (${reason}). Reverse AWB ${returnAwbCode} issued. Escrow frozen.`,
      time: new Date()
    });
    await journey.save();
  }

  const formattedAmount = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;

  // Notify Supplier
  await createNotification(
    shipment.senderId,
    'swap_horizontal_circle',
    `Return Requested — ${shipment.shipmentId}`,
    `Receiver initiated a return request for ${shipment.shipmentId} (Reason: ${reason}). Reverse AWB ${returnAwbCode} issued. Escrow of ${formattedAmount} is frozen pending return inspection.`,
    'alert'
  );

  // Find Receiver
  const receiver = await User.findOne({ phone: shipment.receiverPhone });
  if (receiver) {
    await createNotification(
      receiver._id,
      'assignment_return',
      `Return AWB Issued — ${returnAwbCode}`,
      `Your return request for ${shipment.shipmentId} was recorded. Reverse AWB: ${returnAwbCode}. Courier reverse pickup scheduled.`,
      'shipping'
    );
  }

  return shipment;
};

/**
 * Approves a return request and sets reverse courier in transit.
 */
const approveReturnEscrow = async (shipmentId) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });

  if (!shipment) {
    throw new Error('Shipment not found');
  }

  shipment.returnStatus = 'In Return Transit';
  shipment.status = 'Return In Transit';
  await shipment.save();

  const CarrierJourney = require('../models/CarrierJourney');
  let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
  if (journey) {
    journey.milestones.push({
      status: 'Reverse Pickup Completed',
      location: 'Hub',
      detail: `Package picked up by ${shipment.returnCarrierSlug || 'Courier Partner'}. Moving back to supplier.`,
      time: new Date()
    });
    await journey.save();
  }

  return shipment;
};

/**
 * Confirms receipt of returned package at supplier warehouse, refunds principal + 50% interest to receiver, and credits 50% interest to supplier wallet.
 */
const confirmReturnReceivedEscrow = async (shipmentId) => {
  const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });

  if (!shipment) {
    throw new Error('Shipment not found');
  }

  // Calculate days held & 5.0% annual interest accrued
  const createdDate = shipment.createdAt ? new Date(shipment.createdAt) : new Date();
  const daysHeld = Math.max(1, Math.ceil((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));
  const annualInterestRate = 0.05; // 5.0% p.a.
  const totalAccruedInterest = parseFloat(((shipment.amount * annualInterestRate * daysHeld) / 365).toFixed(2));

  // 50/50 Interest Split
  const receiverInterestShare = parseFloat((totalAccruedInterest / 2).toFixed(2));
  const supplierInterestShare = parseFloat((totalAccruedInterest - receiverInterestShare).toFixed(2));
  const receiverTotalRefund = parseFloat((shipment.amount + receiverInterestShare).toFixed(2));

  shipment.returnStatus = 'Returned & Refunded';
  shipment.status = 'Returned & Refunded';
  shipment.escrowStage = -5;
  await shipment.save();

  // Credit 50% interest share to Supplier's Escrow Wallet
  const supplier = await User.findById(shipment.senderId);
  if (supplier) {
    supplier.walletBalance = (supplier.walletBalance || 0) + supplierInterestShare;
    await supplier.save();
  }

  const formattedPrincipal = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;
  const formattedRecInterest = `₹${new Intl.NumberFormat('en-IN').format(receiverInterestShare)}`;
  const formattedSupInterest = `₹${new Intl.NumberFormat('en-IN').format(supplierInterestShare)}`;
  const formattedRecTotal = `₹${new Intl.NumberFormat('en-IN').format(receiverTotalRefund)}`;

  // Find Receiver and notify of refund (Principal + 50% interest)
  const receiver = await User.findOne({ phone: shipment.receiverPhone });
  if (receiver) {
    await createNotification(
      receiver._id,
      'payments',
      `Return Processed: Escrow Refunded + 50% Interest — ${shipment.shipmentId}`,
      `Returned parcel ${shipment.shipmentId} was received by supplier. Principal (${formattedPrincipal}) + 50% interest share (${formattedRecInterest}) totaling ${formattedRecTotal} has been refunded to your account.`,
      'payment'
    );
  }

  // Notify Supplier of Return Completion & 50% Interest Bonus credited to Wallet
  if (supplier) {
    await createNotification(
      supplier._id,
      'wallet',
      `Return Complete: 50% Interest Share Added to Wallet — ${shipment.shipmentId}`,
      `Returned package ${shipment.shipmentId} arrived at your warehouse. Your 50% escrow interest share (${formattedSupInterest}) has been added to your Escrow Wallet. New Wallet Balance: ₹${supplier.walletBalance.toLocaleString('en-IN')}.`,
      'confirmed'
    );
  }

  return {
    shipment,
    interestSplit: {
      totalAccruedInterest,
      daysHeld,
      receiverPrincipalRefund: shipment.amount,
      receiverInterestShare,
      receiverTotalRefund,
      supplierWalletBonus: supplierInterestShare
    }
  };
};

module.exports = {
  releaseEscrow,
  lockEscrow,
  cancelEscrow,
  refundUndeliveredEscrow,
  requestReturnEscrow,
  approveReturnEscrow,
  confirmReturnReceivedEscrow
};
