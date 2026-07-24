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

module.exports = {
  releaseEscrow,
  lockEscrow
};
