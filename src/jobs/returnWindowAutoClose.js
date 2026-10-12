const cron = require('node-cron');
const Shipment = require('../models/Shipment');
const { releaseEscrow } = require('../services/escrow');

/**
 * Initializes proactive return window auto-close scheduler.
 * Runs every 15 minutes to find shipments where:
 * 1. Parcel delivery was confirmed
 * 2. 24-hour return window has expired
 * 3. Return window was not closed yet
 * 4. No return request or dispute is active
 * Automatically releases escrow principal to the supplier.
 */
const initReturnWindowCron = () => {
  // Allow disabling via environment variable if desired
  if (process.env.ENABLE_RETURN_WINDOW_CRON === 'false') {
    console.log('[RETURN WINDOW CRON] Job is disabled by environment config.');
    return;
  }

  console.log('[RETURN WINDOW CRON] Initializing proactive 24h return window auto-close scheduler (every 15 mins)...');

  // Run every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      const now = new Date();
      
      const expiredShipments = await Shipment.find({
        deliveryConfirmed: true,
        returnWindowClosed: false,
        returnWindowExpiresAt: { $lte: now },
        returnStatus: { $nin: ['Requested', 'Approved', 'In Return Transit'] },
        status: { 
          $nin: [
            'Released', 
            'Locked', 
            'Cancelled', 
            'Undelivered', 
            'Return Requested', 
            'Return In Transit', 
            'Returned & Refunded'
          ] 
        }
      });

      if (expiredShipments.length > 0) {
        console.log(`[RETURN WINDOW CRON] Found ${expiredShipments.length} shipments with expired 24h return window.`);
        
        for (const shipment of expiredShipments) {
          try {
            console.log(`[RETURN WINDOW CRON] Auto-releasing escrow for expired window: ${shipment.shipmentId}`);
            await releaseEscrow(shipment.shipmentId);
            
            shipment.returnWindowClosed = true;
            shipment.returnClosedAt = new Date();
            await shipment.save();
            console.log(`[RETURN WINDOW CRON] Successfully released and closed window for ${shipment.shipmentId}`);
          } catch (itemErr) {
            console.error(`[RETURN WINDOW CRON] Error auto-releasing shipment ${shipment.shipmentId}:`, itemErr.message);
          }
        }
      }
    } catch (err) {
      console.error('[RETURN WINDOW CRON] Execution error:', err.message);
    }
  });
};

module.exports = { initReturnWindowCron };
