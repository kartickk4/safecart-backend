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
      // Find shipments currently in transit (Stage 4) with field projection
      const transitShipments = await Shipment.find({
        escrowStage: 4,
        awbCode: { $ne: "" }
      })
        .select('shipmentId awbCode carrierSlug status escrowStage senderId receiverPhone amount')
        .limit(250);

      console.log(`[TRACKING JOB] Found ${transitShipments.length} active shipments in transit.`);
      if (transitShipments.length === 0) return;

      // Batch 1: Pre-fetch all CarrierJourney documents in a single query (Eliminates N+1)
      const awbCodes = transitShipments.map(s => s.awbCode).filter(Boolean);
      const existingJourneys = await CarrierJourney.find({ awbCode: { $in: awbCodes } });
      const journeyMap = new Map();
      for (const j of existingJourneys) {
        journeyMap.set(j.awbCode, j);
      }

      // Batch 2: Pre-fetch all receiver Users in a single query (Eliminates 2N User queries)
      const phoneSet = new Set();
      for (const s of transitShipments) {
        if (s.receiverPhone) {
          const raw = String(s.receiverPhone).trim();
          phoneSet.add(raw);
          const digits = raw.replace(/\D/g, '');
          if (digits.length >= 10) {
            const ten = digits.slice(-10);
            phoneSet.add(ten);
            phoneSet.add(`+91${ten}`);
            phoneSet.add(`91${ten}`);
            phoneSet.add(`+91 ${ten}`);
          }
        }
      }
      const receiverUsers = phoneSet.size > 0
        ? await User.find({ phone: { $in: Array.from(phoneSet) } }).select('_id phone').lean()
        : [];
      const userPhoneMap = new Map();
      for (const u of receiverUsers) {
        if (u.phone) {
          userPhoneMap.set(u.phone, u);
          const ten = u.phone.replace(/\D/g, '').slice(-10);
          if (ten) userPhoneMap.set(ten, u);
        }
      }

      const getReceiverFromMap = (phone) => {
        if (!phone) return null;
        const raw = String(phone).trim();
        if (userPhoneMap.has(raw)) return userPhoneMap.get(raw);
        const ten = raw.replace(/\D/g, '').slice(-10);
        return ten && userPhoneMap.has(ten) ? userPhoneMap.get(ten) : null;
      };

      for (const shipment of transitShipments) {
        try {
          const carrierSlug = shipment.carrierSlug || process.env.DEFAULT_CARRIER || 'delhivery';
          const trackData = await carrierTracking.getTrackingDetails(carrierSlug, shipment.awbCode);
          if (!trackData) continue;

          // Retrieve journey from batched map or instantiate if absent
          let journey = journeyMap.get(shipment.awbCode);
          if (!journey) {
            journey = new CarrierJourney({
              shipmentId: shipment.shipmentId,
              awbCode: shipment.awbCode,
              courierName: carrierSlug.toUpperCase(),
              milestones: []
            });
            journeyMap.set(shipment.awbCode, journey);
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

            const receiver = getReceiverFromMap(shipment.receiverPhone);
            const notificationPromises = [
              createNotification(
                shipment.senderId,
                'local_shipping',
                `Tracking update: ${newStatus} — ${shipment.shipmentId}`,
                `Your package has updated to: ${newStatus}.`,
                'shipping'
              )
            ];

            if (receiver) {
              notificationPromises.push(
                createNotification(
                  receiver._id,
                  'local_shipping',
                  `Tracking update: ${newStatus} — ${shipment.shipmentId}`,
                  `Your package has updated to: ${newStatus}.`,
                  'shipping'
                )
              );

              if (newStage === 5 || newStatus === 'Delivered') {
                notificationPromises.push(
                  createNotification(
                    receiver._id,
                    'inventory_2',
                    `Parcel Delivered — Action Required: Confirm Parcel`,
                    `Your parcel ${shipment.shipmentId} has been delivered. Please inspect and confirm the parcel.`,
                    'confirmed',
                    shipment.shipmentId,
                    'CONFIRM_PARCEL'
                  )
                );
              }
            }

            await Promise.allSettled(notificationPromises);
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
