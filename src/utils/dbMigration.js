/**
 * SecureKaro Database Migration & Schema Alignment Utility
 * Ensures all collections, indexes, and document fields match latest system rules.
 */
const path = require('path');
const fs = require('fs');

async function runDatabaseMigrations(db) {
  console.log('🔄 [DB MIGRATION] Starting database schema & index validation...');
  const results = {
    indexesCreated: [],
    usersUpdated: 0,
    shipmentsUpdated: 0,
    rewardsUpdated: 0
  };

  try {
    // ----------------------------------------------------
    // 1. INDEX CREATION & VALIDATION
    // ----------------------------------------------------
    const ensureIndex = async (collectionName, indexSpec, options = {}) => {
      try {
        const col = db.collection(collectionName);
        const res = await col.createIndex(indexSpec, options);
        results.indexesCreated.push(`${collectionName}: ${JSON.stringify(indexSpec)} (${res})`);
      } catch (err) {
        console.warn(`[DB MIGRATION] Index warning on ${collectionName}:`, err.message);
      }
    };

    // User Indexes
    await ensureIndex('users', { email: 1, role: 1 }, { unique: true });
    await ensureIndex('users', { phone: 1 }, { sparse: true });

    // Shipment Indexes
    await ensureIndex('shipments', { shipmentId: 1 }, { unique: true });
    await ensureIndex('shipments', { senderId: 1 });
    await ensureIndex('shipments', { receiverPhone: 1 });
    await ensureIndex('shipments', { senderId: 1, confirmationWindowClosed: 1 });
    await ensureIndex('shipments', { senderId: 1, returnStatus: 1 });
    await ensureIndex('shipments', { returnWindowClosed: 1, returnWindowExpiresAt: 1 });
    await ensureIndex('shipments', { returnAllowed: 1 });
    await ensureIndex('shipments', { returnAwbCode: 1 });
    await ensureIndex('shipments', { returnCarrierSlug: 1 });
    await ensureIndex('shipments', { status: 1 });
    await ensureIndex('shipments', { createdAt: -1 });

    // Reward Indexes
    await ensureIndex('rewards', { userId: 1, createdAt: -1 });
    await ensureIndex('rewards', { shipmentId: 1 });
    await ensureIndex('rewards', { type: 1 });

    // Notification Indexes
    await ensureIndex('notifications', { userId: 1, createdAt: -1 });
    await ensureIndex('notifications', { userId: 1, read: 1 });

    // Claim Indexes
    await ensureIndex('claims', { claimId: 1 }, { unique: true });
    await ensureIndex('claims', { shipmentId: 1 });
    await ensureIndex('claims', { filedBy: 1 });

    // CarrierJourney Indexes
    await ensureIndex('carrierjourneys', { shipmentId: 1 }, { unique: true });

    // ----------------------------------------------------
    // 2. USER DATA BACKFILL & CLEANSE
    // ----------------------------------------------------
    const userCol = db.collection('users');
    
    // Clean legacy empty string phone entries
    await userCol.updateMany({ phone: "" }, { $unset: { phone: 1 } });

    // Backfill numeric wallet balances and stats
    const userUpdateRes = await userCol.updateMany(
      {
        $or: [
          { cashbackBalance: { $exists: false } },
          { cashbackBalance: null },
          { totalCashbackEarned: { $exists: false } },
          { totalCashbackEarned: null },
          { totalWithdrawn: { $exists: false } },
          { totalWithdrawn: null },
          { walletBalance: { $exists: false } },
          { walletBalance: null },
          { bankDetails: { $exists: false } },
          { bankDetails: null }
        ]
      },
      [
        {
          $set: {
            cashbackBalance: { $ifNull: ["$cashbackBalance", 0] },
            totalCashbackEarned: { $ifNull: ["$totalCashbackEarned", 0] },
            totalWithdrawn: { $ifNull: ["$totalWithdrawn", 0] },
            walletBalance: { $ifNull: ["$walletBalance", 0] },
            bankDetails: {
              accountHolderName: { $ifNull: ["$bankDetails.accountHolderName", ""] },
              accountNumber: { $ifNull: ["$bankDetails.accountNumber", ""] },
              ifscCode: { $ifNull: ["$bankDetails.ifscCode", ""] },
              bankName: { $ifNull: ["$bankName", ""] },
              upiId: { $ifNull: ["$bankDetails.upiId", ""] }
            }
          }
        }
      ]
    );
    results.usersUpdated = userUpdateRes.modifiedCount || 0;

    // ----------------------------------------------------
    // 3. SHIPMENT DATA BACKFILL & 24H WINDOW FIELDS
    // ----------------------------------------------------
    const shipmentCol = db.collection('shipments');
    const allShipments = await shipmentCol.find({}).toArray();

    for (const s of allShipments) {
      const updates = {};
      const hasAwb = Boolean(s.awbCode && typeof s.awbCode === 'string' && s.awbCode.trim() !== '');
      const hasPaid = Boolean(s.receiverPaymentDone || s.escrowStage >= 2 || (s.status !== 'Awaiting Payment' && s.status !== 'Cancelled'));
      const isReleased = s.status === 'Released';

      if (s.trackingSubmitted === undefined || s.trackingSubmitted === null) {
        updates.trackingSubmitted = hasAwb;
      }
      if (s.receiverPaymentDone === undefined || s.receiverPaymentDone === null) {
        updates.receiverPaymentDone = hasPaid;
      }
      if (s.supplierCashbackAmount === undefined || s.supplierCashbackAmount === null) {
        updates.supplierCashbackAmount = (hasAwb && hasPaid) ? 2 : 0;
      }
      if (s.daysInEscrow === undefined || s.daysInEscrow === null) {
        updates.daysInEscrow = 0;
      }
      if (s.supplierCashbackPaid === undefined || s.supplierCashbackPaid === null) {
        updates.supplierCashbackPaid = 0;
      }
      if (s.principalDisbursedToSupplier === undefined || s.principalDisbursedToSupplier === null) {
        updates.principalDisbursedToSupplier = isReleased ? (s.amount || 0) : 0;
      }
      if (s.principalRefundedToReceiver === undefined || s.principalRefundedToReceiver === null) {
        updates.principalRefundedToReceiver = 0;
      }

      // Check return window state
      if (s.returnAllowed === undefined || s.returnAllowed === null) {
        updates.returnAllowed = true;
      }
      if (s.deliveryConfirmed === undefined || s.deliveryConfirmed === null) {
        updates.deliveryConfirmed = isReleased;
      }
      if (s.returnWindowClosed === undefined || s.returnWindowClosed === null) {
        updates.returnWindowClosed = isReleased;
      }
      if (s.returnWindowChoice === undefined || s.returnWindowChoice === null) {
        updates.returnWindowChoice = isReleased ? 'ImmediateClose' : 'None';
      }

      // Check confirmation window state
      if (s.confirmationWindowClosed === undefined || s.confirmationWindowClosed === null) {
        if (isReleased) {
          updates.confirmationWindowClosed = true;
          if (!s.withdrawableAt) updates.withdrawableAt = s.updatedAt || new Date();
        } else if (s.confirmationWindowExpiresAt && Date.now() >= new Date(s.confirmationWindowExpiresAt).getTime()) {
          updates.confirmationWindowClosed = true;
          if (!s.withdrawableAt) updates.withdrawableAt = new Date(s.confirmationWindowExpiresAt);
        } else {
          updates.confirmationWindowClosed = false;
        }
      }

      if (Object.keys(updates).length > 0) {
        await shipmentCol.updateOne({ _id: s._id }, { $set: updates });
        results.shipmentsUpdated++;
      }
    }

    // ----------------------------------------------------
    // 4. REWARDS DATA BACKFILL
    // ----------------------------------------------------
    const rewardCol = db.collection('rewards');
    
    // Backfill legacy rewards where role or category are missing
    const rewardEarnedRes = await rewardCol.updateMany(
      { 
        type: 'CASHBACK_EARNED',
        $or: [{ role: { $exists: false } }, { role: null }, { category: { $exists: false } }, { category: null }]
      },
      { 
        $set: { 
          role: 'Receiver', 
          category: 'PREPAYMENT_REWARD' 
        } 
      }
    );

    const rewardWithdrawRes = await rewardCol.updateMany(
      { 
        type: 'WITHDRAWAL',
        $or: [{ role: { $exists: false } }, { role: null }, { category: { $exists: false } }, { category: null }]
      },
      { 
        $set: { 
          role: 'Receiver', 
          category: 'WITHDRAWAL' 
        } 
      }
    );

    results.rewardsUpdated = (rewardEarnedRes.modifiedCount || 0) + (rewardWithdrawRes.modifiedCount || 0);

    console.log(`✅ [DB MIGRATION COMPLETED]`);
    console.log(`   - Indexes verified/created: ${results.indexesCreated.length}`);
    console.log(`   - Users backfilled/updated: ${results.usersUpdated}`);
    console.log(`   - Shipments backfilled/updated: ${results.shipmentsUpdated}`);
    console.log(`   - Rewards backfilled/updated: ${results.rewardsUpdated}`);

    return results;
  } catch (error) {
    console.error('❌ [DB MIGRATION ERROR]:', error.message);
    throw error;
  }
}

module.exports = { runDatabaseMigrations };
