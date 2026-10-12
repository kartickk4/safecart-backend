const cron = require('node-cron');
const Shipment = require('../models/Shipment');
const CarrierJourney = require('../models/CarrierJourney');
const User = require('../models/User');
const carrierTracking = require('../services/carrierTracking');
const { createNotification } = require('../services/notification');

/**
 * Helper: Find receiver user by exact or normalized phone number
 */
const findReceiverUser = async (phone) => {
  if (!phone) return null;
  let receiver = await User.findOne({ phone });
  if (!receiver) {
    const sanitized = String(phone).replace(/\D/g, '').slice(-10);
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
 * Initializes the background Carrier Tracking poll job
 */
const initTrackingJob = () => {
  if (process.env.ENABLE_TRACKING_CRON !== 'true') {
    console.log('[TRACKING JOB] Polling job is disabled by environment config.');
    return;
  }

  console.log('[TRACKING JOB] Initializing Carrier Tracking poll job (runs every 30 minutes)...');

  // Schedule to run every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    console.log('[TRACKING JOB] Executing active shipment status poll...');
    
    try {
      // Find all shipments currently in transit (Stage 4)
      const transitShipments = await Shipment.find({
        escrowStage: 4,
        awbCode: { $ne: "" }
      });

      console.log(`[TRACKING JOB] Found ${transitShipments.length} active shipments in transit.`);

      for (const shipment of transitShipments) {
        try {
          const carrierSlug = shipment.carrierSlug || process.env.DEFAULT_CARRIER || 'delhivery';
          const trackData = await carrierTracking.getTrackingDetails(carrierSlug, shipment.awbCode);
          if (!trackData) continue;

          // Update CarrierJourney milestones
          let journey = await CarrierJourney.findOne({ awbCode: shipment.awbCode });
          if (!journey) {
            journey = new CarrierJourney({
              shipmentId: shipment.shipmentId,
              awbCode: shipment.awbCode,
              courierName: carrierSlug.toUpperCase(),
              milestones: []
            });
          }

          if (trackData.activities && trackData.activities.length > 0) {
            journey.milestones = trackData.activities.map(act => ({
              status: act.status || act.activity,
              location: act.location || 'Hub',
              detail: act.activity || `Status: ${act.status}`,
              time: act.date ? new Date(act.date) : new Date()
            }));
            await journey.save();
          }

          // Map tracking status
          let newStatus = shipment.status;
          let newStage = shipment.escrowStage;

          // Sandbox mock prefix mapping
          const statusStr = String(trackData.status).toLowerCase();
          
          if (statusStr.includes('undelivered') || statusStr.includes('failed') || statusStr.includes('rto') || statusStr.includes('returned')) {
            console.log(`[TRACKING JOB] Courier reported shipment ${shipment.shipmentId} undelivered. Refunding escrow principal to receiver...`);
            const escrow = require('../services/escrow');
            await escrow.refundUndeliveredEscrow(shipment.shipmentId, 'Carrier reported delivery attempt failed / returned to origin');
            continue;
          } else if (statusStr.includes('delivered')) {
            newStatus = 'Delivered';
            newStage = 5;
          } else if (statusStr.includes('out for delivery')) {
            newStatus = 'Out for Delivery';
            newStage = 4;
          } else if (statusStr.includes('transit') || statusStr.includes('picked')) {
            newStatus = 'In Transit';
            newStage = 4;
          }

          if (newStatus !== shipment.status || newStage !== shipment.escrowStage) {
            shipment.status = newStatus;
            shipment.escrowStage = newStage;
            await shipment.save();

            console.log(`[TRACKING JOB] Shipment ${shipment.shipmentId} updated to state: ${newStatus}`);

            // Send notification to sender
            await createNotification(
              shipment.senderId,
              'local_shipping',
              `Tracking update: ${newStatus} — ${shipment.shipmentId}`,
              `Your package has updated to: ${newStatus}.`,
              'shipping'
            );

            // Send notification to receiver
            const receiver = await findReceiverUser(shipment.receiverPhone);
            if (receiver) {
              await createNotification(
                receiver._id,
                'local_shipping',
                `Tracking update: ${newStatus} — ${shipment.shipmentId}`,
                `Your package has updated to: ${newStatus}.`,
                'shipping'
              );

              if (newStage === 5 || newStatus === 'Delivered') {
                await createNotification(
                  receiver._id,
                  'inventory_2',
                  `Parcel Delivered — Action Required: Confirm Parcel`,
                  `Your parcel ${shipment.shipmentId} has been delivered. Please inspect and confirm the parcel.`,
                  'confirmed',
                  shipment.shipmentId,
                  'CONFIRM_PARCEL'
                );
              }
            }
          }
        } catch (shipmentErr) {
          console.error(`[TRACKING JOB] Error polling shipment ${shipment.shipmentId}:`, shipmentErr.message);
        }
      }
    } catch (error) {
      console.error('[TRACKING JOB] Cron iteration failed with error:', error);
    }
  });
};

module.exports = {
  initTrackingJob
};
