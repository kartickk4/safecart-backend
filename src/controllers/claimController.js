const Claim = require('../models/Claim');
const Shipment = require('../models/Shipment');
const escrow = require('../services/escrow');
const { createNotification } = require('../services/notification');

/**
 * Helper: Generate Claim ID in form CLM-XXXX-X
 */
const generateClaimId = () => {
  const num = Math.floor(1000 + Math.random() * 9000);
  const char = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `CLM-${num}-${char}`;
};

/**
 * Helper: Tolerant phone match (supports +91, spaces, 10-digit)
 */
const isReceiverMatch = (userPhone, shipmentPhone) => {
  if (!userPhone || !shipmentPhone) return false;
  if (userPhone === shipmentPhone) return true;
  const uDigits = userPhone.replace(/\D/g, '').slice(-10);
  const sDigits = shipmentPhone.replace(/\D/g, '').slice(-10);
  return Boolean(uDigits && sDigits && uDigits === sDigits);
};

/**
 * @desc    File a new dispute claim (locks escrow)
 * @route   POST /api/v1/claims
 * @access  Private
 */
const fileClaim = async (req, res) => {
  const { shipmentId, role, reason, description, evidenceUrls } = req.body;

  try {
    if (!shipmentId || !reason) {
      return res.status(400).json({ error: 'shipmentId and reason are required' });
    }

    const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Verify caller is either sender or receiver
    const isSender = Boolean(shipment.senderId && shipment.senderId.toString() === req.user._id.toString());
    const isReceiver = Boolean(
      (shipment.receiverId && shipment.receiverId.toString() === req.user._id.toString()) ||
      isReceiverMatch(req.user.phone, shipment.receiverPhone)
    );

    if (!isSender && !isReceiver && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to file a claim on this shipment' });
    }

    // Check if a claim already exists for this shipment
    const existingClaim = await Claim.findOne({ shipmentId: shipmentId.toUpperCase() });
    if (existingClaim) {
      return res.status(400).json({ 
        error: 'A dispute claim has already been filed for this shipment',
        claimId: existingClaim.claimId,
        status: existingClaim.status
      });
    }

    const claimRole = role ? role.toLowerCase() : (isSender ? 'supplier' : 'receiver');
    const cleanDesc = (description && description.trim()) ? description.trim() : reason;

    // Lock the escrow in DB if active
    try {
      await escrow.lockEscrow(shipmentId, req.user);
    } catch (escrowErr) {
      console.warn('[CLAIM] Lock escrow note:', escrowErr.message);
    }

    const claimId = generateClaimId();

    const claim = new Claim({
      claimId,
      shipmentId: shipmentId.toUpperCase(),
      filedBy: req.user._id,
      role: claimRole,
      reason,
      description: cleanDesc,
      evidenceUrls: evidenceUrls || [],
      status: 'Under Review'
    });

    await claim.save();

    // Update shipment with authoritative claim information
    shipment.hasActiveClaim = true;
    shipment.claimId = claimId;
    shipment.claimReason = reason;
    shipment.claimDescription = cleanDesc;
    shipment.claimStatus = 'Under Review';
    shipment.claimFiledAt = new Date();
    shipment.claimFiledByRole = claimRole;
    if (shipment.status !== 'Cancelled' && shipment.status !== 'Returned & Refunded') {
      shipment.status = 'Locked';
      shipment.escrowStage = -1;
    }
    await shipment.save();

    // 1. Notify the filer
    await createNotification(
      req.user._id,
      'gavel',
      `Claim Filed — ${claimId}`,
      `Your dispute claim for "${reason}" on shipment ${shipmentId} has been submitted. Order payment is protected in escrow while support reviews it.`,
      'alert'
    );

    // 2. Notify the other party
    const counterPartyId = isReceiver ? shipment.senderId : shipment.receiverId;
    if (counterPartyId) {
      await createNotification(
        counterPartyId,
        'gavel',
        `Dispute Claim Raised: ${shipment.shipmentId}`,
        `The ${claimRole === 'receiver' ? 'buyer' : 'seller'} has filed a dispute claim (${claimId}) regarding: "${reason}". Order funds are secured in escrow.`,
        'alert'
      );
    }

    res.status(201).json({ claim, shipment });
  } catch (error) {
    console.error('File Claim Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Get dispute claim details by Shipment ID
 * @route   GET /api/v1/claims/:shipmentId
 * @access  Private
 */
const getClaimByShipmentId = async (req, res) => {
  try {
    const shipmentId = req.params.shipmentId.toUpperCase();
    const claim = await Claim.findOne({ shipmentId }).populate('filedBy', 'fullName email phone');

    if (!claim) {
      return res.status(404).json({ error: 'No dispute claim found for this shipment' });
    }

    // Verify user is either sender or receiver
    const shipment = await Shipment.findOne({ shipmentId });
    if (!shipment) {
      return res.status(404).json({ error: 'Associated shipment not found' });
    }

    const isSender = shipment.senderId.toString() === req.user._id.toString();
    const isReceiver = isReceiverMatch(req.user.phone, shipment.receiverPhone);

    if (!isSender && !isReceiver && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to view this claim' });
    }

    res.json(claim);
  } catch (error) {
    console.error('Get Claim Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Get count of active claims filed by current user
 * @route   GET /api/v1/claims/my-count
 * @access  Private
 */
const getMyClaimsCount = async (req, res) => {
  try {
    const count = await Claim.countDocuments({ filedBy: req.user._id, status: 'Under Review' });
    res.json({ count });
  } catch (error) {
    console.error('Get Claims Count Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  fileClaim,
  getClaimByShipmentId,
  getMyClaimsCount
};

