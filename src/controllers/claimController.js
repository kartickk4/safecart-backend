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
 * @desc    File a new dispute claim (locks escrow)
 * @route   POST /api/v1/claims
 * @access  Private
 */
const fileClaim = async (req, res) => {
  const { shipmentId, role, reason, description, evidenceUrls } = req.body;

  try {
    if (!shipmentId || !role || !reason || !description) {
      return res.status(400).json({ error: 'shipmentId, role (supplier/receiver), reason, and description are required' });
    }

    const shipment = await Shipment.findOne({ shipmentId: shipmentId.toUpperCase() });
    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Verify caller is either sender or receiver
    const isSender = shipment.senderId.toString() === req.user._id.toString();
    const isReceiver = shipment.receiverPhone === req.user.phone;

    if (!isSender && !isReceiver) {
      return res.status(403).json({ error: 'Not authorized to file a claim on this shipment' });
    }

    // Check if a claim already exists for this shipment
    const existingClaim = await Claim.findOne({ shipmentId: shipmentId.toUpperCase() });
    if (existingClaim) {
      return res.status(400).json({ error: 'A dispute claim has already been filed for this shipment' });
    }

    // Lock the escrow in DB
    await escrow.lockEscrow(shipmentId, req.user);

    const claimId = generateClaimId();

    const claim = new Claim({
      claimId,
      shipmentId: shipmentId.toUpperCase(),
      filedBy: req.user._id,
      role,
      reason,
      description,
      evidenceUrls: evidenceUrls || [],
      status: 'Under Review'
    });

    await claim.save();

    // Notify the filer
    await createNotification(
      req.user._id,
      'gavel',
      `Dispute Filed — ${claimId}`,
      `Dispute successfully initiated for shipment ${shipmentId}. Escrow locked.`,
      'alert'
    );

    res.status(201).json(claim);
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
    const isReceiver = shipment.receiverPhone === req.user.phone;

    if (!isSender && !isReceiver && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to view this claim' });
    }

    res.json(claim);
  } catch (error) {
    console.error('Get Claim Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  fileClaim,
  getClaimByShipmentId
};
