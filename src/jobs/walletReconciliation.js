const cron = require('node-cron');
const { reconcileAllWallets } = require('../services/reconciliationService');

/**
 * Initializes nightly wallet ledger reconciliation scheduler.
 * Runs at 00:00 every day to verify double-entry ledger balance integrity across all users.
 */
const initWalletReconciliationCron = () => {
  if (process.env.ENABLE_RECONCILIATION_CRON === 'false') {
    console.log('[RECONCILIATION CRON] Job is disabled by environment config.');
    return;
  }

  console.log('[RECONCILIATION CRON] Initializing automated nightly wallet ledger audit scheduler (daily at midnight)...');

  // Run at 00:00 every night
  cron.schedule('0 0 * * *', async () => {
    try {
      console.log('[RECONCILIATION CRON] Running scheduled nightly wallet ledger integrity check...');
      await reconcileAllWallets();
    } catch (err) {
      console.error('[RECONCILIATION CRON] Error executing nightly reconciliation:', err.message);
    }
  });
};

module.exports = {
  initWalletReconciliationCron
};
