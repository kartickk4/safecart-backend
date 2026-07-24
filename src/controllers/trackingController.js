const Shipment = require('../models/Shipment');
const CarrierJourney = require('../models/CarrierJourney');
const User = require('../models/User');
const { createNotification } = require('../services/notification');

/**
 * @desc    Receive simulated tracking webhook updates
 * @route   POST /api/v1/tracking/webhook/carrier-tracking
 * @access  Public
 */
const handleWebhook = async (req, res) => {
  const { awb, status, current_status, location, activities } = req.body;

  const awbCode = awb || req.body.awbCode;
  const trackingStatus = status || current_status || 'In Transit';

  try {
    if (!awbCode) {
      return res.status(400).json({ error: 'Awb/tracking code is required in webhook body' });
    }

    const shipment = await Shipment.findOne({ awbCode });
    if (!shipment) {
      console.warn(`[TRACKING WEBHOOK] Received update for untracked AWB: ${awbCode}`);
      return res.status(404).json({ error: 'Associated shipment not found' });
    }

    // Update CarrierJourney milestones
    let journey = await CarrierJourney.findOne({ awbCode });
    if (!journey) {
      journey = new CarrierJourney({
        shipmentId: shipment.shipmentId,
        awbCode,
        courierName: shipment.carrierSlug ? shipment.carrierSlug.toUpperCase() : "Carrier Partner",
        milestones: []
      });
    }

    if (activities && Array.isArray(activities)) {
      journey.milestones = activities.map(act => ({
        status: act.status || act.activity,
        location: act.location || 'Hub',
        detail: act.activity || act.detail || `Status: ${act.status}`,
        time: act.date ? new Date(act.date) : (act.time ? new Date(act.time) : new Date())
      }));
    } else {
      journey.milestones.push({
        status: trackingStatus,
        location: location || 'Sorting Facility',
        detail: `Status updated via webhook to: ${trackingStatus}`,
        time: new Date()
      });
    }
    await journey.save();

    // Map status string to escrow stages
    let newStatus = shipment.status;
    let newStage = shipment.escrowStage;

    const statusStr = trackingStatus.toLowerCase();
    if (statusStr.includes('delivered')) {
      newStatus = 'Delivered';
      newStage = 5;
    } else if (statusStr.includes('out for delivery')) {
      newStatus = 'Out for Delivery';
      newStage = 4;
    } else if (statusStr.includes('transit') || statusStr.includes('picked') || statusStr.includes('shipped')) {
      newStatus = 'In Transit';
      newStage = 4;
    } else if (statusStr.includes('pending')) {
      newStatus = 'Pending Pickup';
      newStage = 3;
    }

    // Save only if changes occurred
    if (newStatus !== shipment.status || newStage !== shipment.escrowStage) {
      shipment.status = newStatus;
      shipment.escrowStage = newStage;
      await shipment.save();

      console.log(`[TRACKING WEBHOOK] Shipment ${shipment.shipmentId} updated to: ${newStatus}`);

      // Send notifications to sender
      await createNotification(
        shipment.senderId,
        'local_shipping',
        `Logistics Update: ${newStatus} — ${shipment.shipmentId}`,
        `Your shipment status is: ${newStatus}. Location: ${location || 'Hub'}.`,
        'shipping'
      );

      // Send notification to receiver (if in database)
      const receiver = await User.findOne({ phone: shipment.receiverPhone });
      if (receiver) {
        await createNotification(
          receiver._id,
          'local_shipping',
          `Logistics Update: ${newStatus} — ${shipment.shipmentId}`,
          `Your shipment status is: ${newStatus}. Location: ${location || 'Hub'}.`,
          'shipping'
        );

        // If delivered, notify receiver to confirm and release
        if (newStage === 5) {
          const amtFormatted = `₹${new Intl.NumberFormat('en-IN').format(shipment.amount)}`;
          await createNotification(
            receiver._id,
            'inventory_2',
            `Action Required: Confirm Receipt — ${shipment.shipmentId}`,
            `The courier reports your package has been delivered. Please confirm receipt to release the escrow of ${amtFormatted}.`,
            'confirmed'
          );
        }
      }
    }

    res.json({ message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  handleWebhook
};
