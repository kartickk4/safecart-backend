const Shipment = require('../models/Shipment');
const CarrierJourney = require('../models/CarrierJourney');
const User = require('../models/User');
const carrierTracking = require('../services/carrierTracking');
const escrow = require('../services/escrow');
const cashfreeService = require('../services/cashfreeService');
const { createNotification } = require('../services/notification');

/**
 * Helper: Generate Shipment ID in form SPL-XXXX-X
 */
const generateShipmentId = () => {
  const num = Math.floor(1000 + Math.random() * 9000);
  const char = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `SPL-${num}-${char}`;
};

/**
 * @desc    List shipments involving current user
 * @route   GET /api/v1/shipments
 * @access  Private
 */
const getShipments = async (req, res) => {
  try {
    const userPhone = req.user.phone;
    
    // Find shipments where user is sender OR receiver
    const shipments = await Shipment.find({
      $or: [
        { senderId: req.user._id },
        { receiverPhone: userPhone }
      ]
    }).sort({ createdAt: -1 });

    res.json(shipments);
  } catch (error) {
    console.error('Get Shipments Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Get detailed shipment by ID + carrier tracking
 * @route   GET /api/v1/shipments/:id
 * @access  Private
 */
const getShipmentById = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Verify user is either sender or receiver
    const userPhone = req.user.phone;
    const isSender = shipment.senderId.toString() === req.user._id.toString();
    const isReceiver = shipment.receiverPhone === userPhone;

    if (!isSender && !isReceiver && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to view this shipment' });
    }

    // Get journey track
    const journey = await CarrierJourney.findOne({ shipmentId: id });

    res.json({
      shipment,
      journey: journey || null
    });
  } catch (error) {
    console.error('Get Shipment Details Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Create escrow shipment booking
 * @route   POST /api/v1/shipments
 * @access  Private
 */
const createShipment = async (req, res) => {
  const { receiverName, receiverPhone, description, amount, city, fundEscrow, carrierSlug, awbCode } = req.body;

  try {
    if (!receiverName || !receiverPhone || !description || !amount) {
      return res.status(400).json({ error: 'Please enter receiver details, description, and amount' });
    }

    // Safecart rule: Sender must have bank details set to receive/disburse escrow payouts
    const sender = await User.findById(req.user._id);
    if (!sender.bankDetails || !sender.bankDetails.accountNumber) {
      return res.status(400).json({ 
        error: 'Bank details required',
        message: 'Please complete your bank account settings before creating shipments.'
      });
    }

    const shipmentId = generateShipmentId();

    // Create Cashfree Payment Link for receiver
    const cfLink = await cashfreeService.createPaymentLink({
      shipmentId,
      amount,
      receiverName,
      receiverPhone,
      description
    });

    const shipment = new Shipment({
      shipmentId,
      senderId: req.user._id,
      receiverName,
      receiverPhone,
      description,
      amount,
      city: city || "",
      carrierSlug: carrierSlug || "",
      awbCode: awbCode || "",
      paymentLink: cfLink.linkUrl,
      cashfreeLinkId: cfLink.linkId,
      status: 'Awaiting Payment',
      escrowStage: 1
    });

    await shipment.save();

    // Create notifications for sender
    await createNotification(
      req.user._id,
      'add_box',
      `Shipment Created — ${shipmentId}`,
      `Escrow shipment created for ${receiverName}. Escrow amount: ₹${amount}.`,
      'shipping'
    );

    // If fundEscrow is set to true, proceed immediately to funding & logistics booking
    if (fundEscrow === true) {
      // 1. Simulate funding (Stage 2)
      shipment.status = 'Pending Pickup';
      shipment.escrowStage = 3;

      // 2. Book with Carrier Tracking Service (Stage 3)
      const logisticsData = await carrierTracking.bookShipment(shipment, sender);

      shipment.carrierSlug = logisticsData.carrierSlug;
      shipment.awbCode = logisticsData.awbCode;
      shipment.shippingLabelUrl = logisticsData.shippingLabelUrl;
      await shipment.save();

      // Initialize the CarrierJourney tracking document
      let origin = "Primary Location";
      let dest = "Receiver Location";
      if (city) {
        if (city.includes('->')) {
          const p = city.split('->');
          origin = p[0].trim();
          dest = p[1].trim();
        } else if (city.includes('→')) {
          const p = city.split('→');
          origin = p[0].trim();
          dest = p[1].trim();
        }
      }

      const journey = new CarrierJourney({
        shipmentId,
        awbCode: logisticsData.awbCode,
        courierName: logisticsData.carrierSlug ? logisticsData.carrierSlug.toUpperCase() : "Carrier Partner",
        milestones: [
          {
            status: "Pending Pickup",
            location: origin,
            detail: `Order processed with carrier ${logisticsData.carrierSlug || 'Partner'}.`,
            time: new Date()
          }
        ]
      });
      await journey.save();

      // Notify both parties of payment secured
      await createNotification(
        req.user._id,
        'payments',
        `Payment Secured — ${shipmentId}`,
        `Payment secured in escrow. AWB ${logisticsData.awbCode} generated.`,
        'payment'
      );

      // Notify receiver if they are registered in the system
      const receiver = await User.findOne({ phone: receiverPhone });
      if (receiver) {
        await createNotification(
          receiver._id,
          'inventory_2',
          `Escrow Funded: ${shipmentId}`,
          `A secure parcel from ${sender.fullName} is awaiting carrier pickup. Escrow of ₹${amount} is active.`,
          'payment'
        );
      }
    }

    res.status(201).json(shipment);
  } catch (error) {
    console.error('Create Shipment Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Fund escrow for an existing Stage 1 shipment
 * @route   POST /api/v1/shipments/:id/fund
 * @access  Private
 */
const fundShipment = async (req, res) => {
  const { carrierSlug, awbCode } = req.body;

  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    if (shipment.escrowStage !== 1) {
      return res.status(400).json({ error: 'Shipment has already been funded or processed' });
    }

    if (carrierSlug) shipment.carrierSlug = carrierSlug;
    if (awbCode) shipment.awbCode = awbCode;

    const sender = await User.findById(shipment.senderId);

    // Update status to Pending Pickup & Stage 3
    shipment.status = 'Pending Pickup';
    shipment.escrowStage = 3;

    // Trigger carrier tracking booking simulation or pass-through
    const logisticsData = await carrierTracking.bookShipment(shipment, sender);

    shipment.carrierSlug = logisticsData.carrierSlug;
    shipment.awbCode = logisticsData.awbCode;
    shipment.shippingLabelUrl = logisticsData.shippingLabelUrl;
    await shipment.save();

    // Initialize Carrier Journey
    let origin = "Primary Location";
    let dest = "Receiver Location";
    if (shipment.city) {
      if (shipment.city.includes('->')) {
        const p = shipment.city.split('->');
        origin = p[0].trim();
        dest = p[1].trim();
      } else if (shipment.city.includes('→')) {
        const p = shipment.city.split('→');
        origin = p[0].trim();
        dest = p[1].trim();
      }
    }

    const journey = new CarrierJourney({
      shipmentId: id,
      awbCode: logisticsData.awbCode,
      courierName: logisticsData.carrierSlug ? logisticsData.carrierSlug.toUpperCase() : "Carrier Partner",
      milestones: [
        {
          status: "Pending Pickup",
          location: origin,
          detail: `Order processed with carrier ${logisticsData.carrierSlug || 'Partner'}.`,
          time: new Date()
        }
      ]
    });
    await journey.save();

    // Create notification
    await createNotification(
      shipment.senderId,
      'payments',
      `Payment Secured — ${id}`,
      `Escrow funded. AWB ${logisticsData.awbCode} issued.`,
      'payment'
    );

    const receiver = await User.findOne({ phone: shipment.receiverPhone });
    if (receiver) {
      await createNotification(
        receiver._id,
        'inventory_2',
        `Escrow Funded: ${id}`,
        `A secure parcel from ${sender.fullName} has been funded (₹${shipment.amount}).`,
        'payment'
      );
    }

    res.json(shipment);
  } catch (error) {
    console.error('Fund Escrow Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Release escrow funds to Sender (called by Receiver)
 * @route   PUT /api/v1/shipments/:id/release
 * @access  Private
 */
const releaseShipment = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Verify caller is the receiver
    if (shipment.receiverPhone !== req.user.phone && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the receiver can release these escrow funds' });
    }

    const updatedShipment = await escrow.releaseEscrow(id, req.user._id);
    res.json(updatedShipment);
  } catch (error) {
    console.error('Release Escrow Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Cancel shipment & refund escrow
 * @route   PUT /api/v1/shipments/:id/cancel
 * @access  Private
 */
const cancelShipment = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { reason } = req.body;
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    const isSender = shipment.senderId.toString() === req.user._id.toString();
    const isReceiver = shipment.receiverPhone === req.user.phone;

    if (!isSender && !isReceiver && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to cancel this shipment' });
    }

    const updatedShipment = await escrow.cancelEscrow(id, req.user._id, reason || 'User requested cancellation');
    res.json(updatedShipment);
  } catch (error) {
    console.error('Cancel Shipment Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Mark shipment as undelivered & refund escrow + interest to receiver
 * @route   PUT /api/v1/shipments/:id/undelivered
 * @access  Private
 */
const markUndelivered = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { reason } = req.body;
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    const isSender = shipment.senderId.toString() === req.user._id.toString();
    const isReceiver = shipment.receiverPhone === req.user.phone;

    if (!isSender && !isReceiver && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to report undelivered status for this shipment' });
    }

    const result = await escrow.refundUndeliveredEscrow(id, reason || 'Carrier delivery failed or returned to origin');
    res.json(result);
  } catch (error) {
    console.error('Mark Undelivered Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Request return & generate Reverse AWB (REV-SPL-XXXX)
 * @route   PUT /api/v1/shipments/:id/return-request
 * @access  Private
 */
const requestReturn = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { reason } = req.body;
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    const updatedShipment = await escrow.requestReturnEscrow(id, req.user._id, reason || 'Receiver requested return');
    res.json(updatedShipment);
  } catch (error) {
    console.error('Request Return Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Supplier approves return & sets reverse courier in transit
 * @route   PUT /api/v1/shipments/:id/return-approve
 * @access  Private
 */
const approveReturn = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const updatedShipment = await escrow.approveReturnEscrow(id);
    res.json(updatedShipment);
  } catch (error) {
    console.error('Approve Return Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Confirm return arrival at supplier warehouse & refund receiver
 * @route   PUT /api/v1/shipments/:id/return-confirm
 * @access  Private
 */
const confirmReturnReceived = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const updatedShipment = await escrow.confirmReturnReceivedEscrow(id);
    res.json(updatedShipment);
  } catch (error) {
    console.error('Confirm Return Received Error:', error.message);
    res.status(400).json({ error: error.message });
  }
/**
 * @desc    Generate / Get Cashfree Receiver Payment Link
 * @route   POST /api/v1/shipments/:id/payment-link
 * @access  Private
 */
const generatePaymentLink = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    if (!shipment.paymentLink) {
      const cfLink = await cashfreeService.createPaymentLink({
        shipmentId: shipment.shipmentId,
        amount: shipment.amount,
        receiverName: shipment.receiverName,
        receiverPhone: shipment.receiverPhone,
        description: shipment.description
      });

      shipment.paymentLink = cfLink.linkUrl;
      shipment.cashfreeLinkId = cfLink.linkId;
      await shipment.save();
    }

    res.json({
      shipmentId: shipment.shipmentId,
      amount: shipment.amount,
      receiverName: shipment.receiverName,
      receiverPhone: shipment.receiverPhone,
      paymentLink: shipment.paymentLink,
      cashfreeLinkId: shipment.cashfreeLinkId,
      status: 'SUCCESS'
    });
  } catch (error) {
    console.error('Generate Payment Link Error:', error);
    res.status(500).json({ error: 'Failed to generate Cashfree payment link' });
  }
};

module.exports = {
  getShipments,
  getShipmentById,
  createShipment,
  fundShipment,
  releaseShipment,
  cancelShipment,
  markUndelivered,
  requestReturn,
  approveReturn,
  confirmReturnReceived,
  generatePaymentLink
};
