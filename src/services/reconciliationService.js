const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');

/**
 * Reconcile a single user's wallet against their immutable transaction ledger
 * @param {string} userId
 * @returns {Promise<Object>}
 */
const reconcileUserWallet = async (userId) => {
  const user = await User.findById(userId).select('walletBalance cashbackBalance fullName email role');
  if (!user) return { error: 'User not found' };

  const userMatch = { $or: [{ sellerId: user._id }, { userId: user._id }], status: 'success' };

  const ledgerAgg = await WalletTransaction.aggregate([
    { $match: userMatch },
    { $group: { _id: '$type', total: { $sum: '$amount' } } }
  ]);

  let totalCredit = 0;
  let totalDebit = 0;
  for (const item of ledgerAgg) {
    if (item._id === 'credit') totalCredit = parseFloat(Number(item.total).toFixed(2));
    if (item._id === 'debit') totalDebit = parseFloat(Number(item.total).toFixed(2));
  }

  const expectedBalance = parseFloat((totalCredit - totalDebit).toFixed(2));
  const actualBalance = parseFloat((Number(user.walletBalance) || 0).toFixed(2));
  const discrepancy = parseFloat((actualBalance - expectedBalance).toFixed(2));
  const isHealthy = Math.abs(discrepancy) < 0.01;

  return {
    userId: user._id,
    userName: user.fullName,
    role: user.role,
    actualBalance,
    expectedBalance,
    totalCredit,
    totalDebit,
    discrepancy,
    isHealthy
  };
};

/**
 * Platform-wide Ledger Audit: Reconcile all wallets across the entire system
 * @returns {Promise<Object>}
 */
const reconcileAllWallets = async () => {
  console.log('[FINTECH AUDIT] Starting automated platform-wide wallet ledger reconciliation...');
  const startTime = Date.now();

  // Find all users who either have a non-zero balance or have ledger entries
  const usersWithBalance = await User.find({
    $or: [{ walletBalance: { $ne: 0 } }, { cashbackBalance: { $ne: 0 } }]
  }).select('_id walletBalance cashbackBalance fullName email role');

  const distinctTransactionUsers = await WalletTransaction.distinct('sellerId');
  const distinctBuyerIds = await WalletTransaction.distinct('userId');

  const allUserIdsSet = new Set([
    ...usersWithBalance.map(u => u._id.toString()),
    ...distinctTransactionUsers.map(id => id.toString()),
    ...distinctBuyerIds.filter(Boolean).map(id => id.toString())
  ]);

  const auditResults = [];
  let healthyCount = 0;
  let discrepancyCount = 0;
  let totalPlatformActualBalance = 0;
  let totalPlatformExpectedBalance = 0;

  for (const uid of allUserIdsSet) {
    try {
      const res = await reconcileUserWallet(uid);
      if (!res.error) {
        totalPlatformActualBalance += res.actualBalance;
        totalPlatformExpectedBalance += res.expectedBalance;

        if (res.isHealthy) {
          healthyCount++;
        } else {
          discrepancyCount++;
          auditResults.push(res);
          console.warn(`[FINTECH AUDIT ALERT] Discrepancy detected for user ${res.userName} (${uid}): Actual ₹${res.actualBalance} vs Ledger ₹${res.expectedBalance} (Diff: ₹${res.discrepancy})`);
        }
      }
    } catch (e) {
      console.error(`[FINTECH AUDIT] Error reconciling user ${uid}:`, e.message);
    }
  }

  const durationMs = Date.now() - startTime;
  const netPlatformVariance = parseFloat((totalPlatformActualBalance - totalPlatformExpectedBalance).toFixed(2));

  const report = {
    timestamp: new Date().toISOString(),
    durationMs,
    totalAccountsAudited: allUserIdsSet.size,
    healthyAccounts: healthyCount,
    discrepancyCount,
    totalPlatformActualBalance: parseFloat(totalPlatformActualBalance.toFixed(2)),
    totalPlatformExpectedBalance: parseFloat(totalPlatformExpectedBalance.toFixed(2)),
    netPlatformVariance,
    isPlatformHealthy: discrepancyCount === 0 && Math.abs(netPlatformVariance) < 0.05,
    anomalies: auditResults
  };

  console.log(`[FINTECH AUDIT COMPLETE] Audited ${allUserIdsSet.size} accounts in ${durationMs}ms. Healthy: ${healthyCount}, Anomalies: ${discrepancyCount}, Net Variance: ₹${netPlatformVariance}`);
  return report;
};

module.exports = {
  reconcileUserWallet,
  reconcileAllWallets
};

