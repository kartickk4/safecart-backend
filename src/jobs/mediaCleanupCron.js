const cron = require('node-cron');
const { cleanupCompletedShipmentPhotos } = require('../services/mediaCleanupService');

/**
 * Initializes daily media auto-cleanup scheduler.
 * Runs at 03:00 AM every night to delete photos of finalized shipments from Cloudflare R2,
 * keeping storage permanently within Cloudflare's 10 GB free tier.
 */
const initMediaCleanupCron = () => {
  if (process.env.ENABLE_MEDIA_CLEANUP_CRON === 'false') {
    console.log('[MEDIA CLEANUP CRON] Job is disabled by environment config.');
    return;
  }

  console.log('[MEDIA CLEANUP CRON] Initializing daily Cloudflare R2 storage auto-cleanup scheduler (daily at 03:00 AM)...');

  // Run at 03:00 AM every day
  cron.schedule('0 3 * * *', async () => {
    try {
      console.log('[MEDIA CLEANUP CRON] Running scheduled Cloudflare R2 photo cleanup...');
      // 7 days retention after delivery confirmation & closed return window
      await cleanupCompletedShipmentPhotos(7);
    } catch (err) {
      console.error('[MEDIA CLEANUP CRON] Error executing media cleanup:', err.message);
    }
  });
};

module.exports = {
  initMediaCleanupCron
};
