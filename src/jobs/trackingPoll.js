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
 * Core sync logic for all active shipments
 */
const syncAllActiveShipments = async () => {
  console.log('[TRACKING JOB] Executing active shipment status poll...');
  
  try {
    // Find active shipments that have an AWB code and are not yet terminal
    const transitShipments = await Shipment.find({
      status: { 
        $in: [
          'In Transit', 
          'Out for Delivery', 
          'Pending Pickup', 
          'Reached Destination Hub', 
          'Picked Up', 
          'Dispatched', 
          'Awaiting Courier Dispatch'
        ] 
      },
      awbCode: { $exists: true, $nin: ['', 'N/A', null] }
    })
      .select('shipmentId awbCode carrierSlug status escrowStage senderId receiverPhone amount')
      .limit(300);

    console.log(`[TRACKING JOB] Found ${transitShipments.length} active shipments to sync.`);
    if (transitShipments.length === 0) return;

    // Batch 1: Pre-fetch CarrierJourney documents in a single query
    const awbCodes = transitShipments.map(s => s.awbCode).filter(Boolean);
    const existingJourneys = await CarrierJourney.find({ awbCode: { $in: awbCodes } });
    const journeyMap = new Map();
    for (const j of existingJourneys) {
      journeyMap.set(j.awbCode, j);
    }

    // Batch 2: Pre-fetch receiver users to prevent N+1 queries
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

        // Retrieve or instantiate CarrierJourney
        let journey = journeyMap.get(shipment.awbCode);
        if (!journey) {
          journey = new CarrierJourney({
            shipmentId: shipment.shipmentId,
            awbCode: shipment.awbCode,
            courierName: (trackData.courierName || carrierSlug).toUpperCase(),
            milestones: []
          });
          journeyMap.set(shipment.awbCode, journey);
        }

        if (trackData.activities && trackData.activities.length > 0) {
          journey.milestones = trackData.activities.map(act => ({
            status: act.status || act.activity,
            location: act.location || 'Logistics Hub',
            detail: act.activity || `Status: ${act.status}`,
            time: act.date ? new Date(act.date) : new Date()
          }));
          if (trackData.courierName) {
            journey.courierName = trackData.courierName;
          }
          await journey.save();
        }

        // Map tracking status to Platform Escrow Stages
        let newStatus = shipment.status;
        let newStage = shipment.escrowStage;

        const statusStr = String(trackData.status || '').toLowerCase();
        
        if (statusStr.includes('undelivered') || statusStr.includes('failed') || statusStr.includes('rto') || statusStr.includes('returned')) {
          console.log(`[TRACKING JOB] Courier reported shipment ${shipment.shipmentId} undelivered. Handling RTO/undelivered...`);
          try {
            const escrow = require('../services/escrow');
            if (escrow.refundUndeliveredEscrow) {
              await escrow.refundUndeliveredEscrow(shipment.shipmentId, 'Carrier reported delivery attempt failed / returned to origin');
            }
          } catch (escrowErr) {
            console.warn('[TRACKING JOB Escrow refund warning]:', escrowErr.message);
          }
          continue;
        } else if (statusStr.includes('delivered')) {
          newStatus = 'Delivered';
          newStage = 5;
        } else if (statusStr.includes('out for delivery')) {
          newStatus = 'Out for Delivery';
          newStage = 4;
        } else if (statusStr.includes('transit') || statusStr.includes('picked') || statusStr.includes('shipped') || statusStr.includes('dispatched')) {
          newStatus = 'In Transit';
          newStage = 4;
        }

        if (newStatus !== shipment.status || newStage !== shipment.escrowStage) {
          shipment.status = newStatus;
          shipment.escrowStage = newStage;
          await shipment.save();

          console.log(`[TRACKING JOB] Shipment ${shipment.shipmentId} (${shipment.awbCode}) updated to: ${newStatus}`);

          const receiver = getReceiverFromMap(shipment.receiverPhone);
          const notificationPromises = [
            createNotification(
              shipment.senderId,
              'local_shipping',
              `Tracking update: ${newStatus} — ${shipment.shipmentId}`,
              `Your package (${shipment.awbCode}) is now: ${newStatus}.`,
              'shipping'
            )
          ];

          if (receiver) {
            notificationPromises.push(
              createNotification(
                receiver._id,
                'local_shipping',
                `Tracking update: ${newStatus} — ${shipment.shipmentId}`,
                `Your package (${shipment.awbCode}) is now: ${newStatus}.`,
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

        // Small throttle to avoid hitting carrier rate limits
        await new Promise(r => setTimeout(r, 200));
      } catch (shipmentErr) {
        console.error(`[TRACKING JOB] Error polling shipment ${shipment.shipmentId}:`, shipmentErr.message);
      }
    }
  } catch (error) {
    console.error('[TRACKING JOB] Cron iteration failed with error:', error);
  }
};

/**
 * Initializes the background Carrier Tracking poll job
 */
const initTrackingJob = () => {
  // Runs by default unless explicitly disabled with ENABLE_TRACKING_CRON=false
  if (process.env.ENABLE_TRACKING_CRON === 'false') {
    console.log('[TRACKING JOB] Polling job is disabled by ENABLE_TRACKING_CRON=false config.');
    return;
  }

  console.log('[TRACKING JOB] Initializing Universal Carrier Tracking poll job (runs every 20 minutes)...');

  // Schedule to run every 20 minutes
  cron.schedule('*/20 * * * *', async () => {
    await syncAllActiveShipments();
  });

  // Also perform a fast non-blocking startup check after 15 seconds
  setTimeout(() => {
    syncAllActiveShipments().catch(e => console.warn('[TRACKING JOB Startup Poll Note]:', e.message));
  }, 15000);
};

module.exports = {
  initTrackingJob,
  syncAllActiveShipments
};
