const express = require('express');
const path = require('path');
const fs = require('fs');

function loadMod(type, name) {
  const candidates = [
    path.resolve(__dirname, '..', type, name),
    path.resolve(__dirname, type, name),
    path.resolve(__dirname, name),
    path.resolve(process.cwd(), 'src', type, name),
    path.resolve(process.cwd(), type, name),
    path.resolve(process.cwd(), name)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c + '.js')) return require(c + '.js');
    if (fs.existsSync(c)) return require(c);
  }
  try { return require(`../${type}/${name}`); } catch(e) {}
  try { return require(`./${type}/${name}`); } catch(e) {}
  return require(`./${name}`);
}

const { protect, admin } = loadMod('middleware', 'auth');
const adminController = loadMod('controllers', 'adminController');

const router = express.Router();

// Apply authentication and admin authorization to ALL admin routes
router.use(protect);
router.use(admin);

// Analytics & Overview
router.get('/analytics', adminController.getAnalyticsDashboard);

// User Management
router.get('/users', adminController.getAllUsers);
router.get('/users/:id', adminController.getUserById);
router.put('/users/:id/suspend', adminController.suspendUser);
router.put('/users/:id/unsuspend', adminController.unsuspendUser);
router.put('/users/:id/role', adminController.updateUserRole);
router.delete('/users/:id', adminController.deleteUser);
router.put('/users/:id/verify', adminController.toggleUserVerification);
router.put('/users/:id/profile', adminController.updateUserProfileFields);
router.post('/users/:id/notify', adminController.sendDirectNotification);
router.post('/users/:id/adjust-balance', adminController.adjustUserBalances);
router.get('/users/:id/transactions', adminController.getUserTransactions);

// Returns & Reverse Logistics
router.get('/returns', adminController.getAllReturns);
router.put('/shipments/:id/return-status', adminController.overrideReturnStatus);
router.post('/shipments/:id/return-approve', adminController.forceApproveReturn);
router.post('/shipments/:id/return-reject', adminController.forceRejectReturn);
router.post('/shipments/:id/set-return-awb', adminController.setReturnAwb);
router.post('/shipments/:id/set-replacement-awb', adminController.setReplacementAwb);

// Shipment Overrides & Force Operations
router.get('/shipments', adminController.getAllShipments);
router.get('/shipments/:id', adminController.getSingleShipment);
router.put('/shipments/:id/override-status', adminController.overrideShipmentStatus);
router.put('/shipments/:id/cancel', adminController.cancelShipmentAdmin);
router.put('/shipments/:id/confirm-delivery', adminController.confirmDeliveryManually);
router.put('/shipments/:id/lock', adminController.toggleShipmentLock);
router.put('/shipments/:id/edit-details', adminController.editShipmentDetails);
router.put('/shipments/:id/inbox-qr', adminController.manageInboxQr);
router.post('/shipments/:id/force-release', adminController.forceReleaseEscrow);
router.post('/shipments/:id/force-refund', adminController.forceRefundEscrow);

// Dispute Claims Court & Arbitration
router.get('/disputes', adminController.getAllDisputes);
router.post('/disputes/:id/resolve', adminController.resolveDispute);

// Financial Ledger, Live Escrow & Withdrawals
router.get('/finance/summary', adminController.getFinancialSummary);
router.get('/finance/escrow-live', adminController.getLiveEscrowBreakdown);
router.get('/finance/withdrawals', adminController.getWithdrawalRequests);
router.post('/finance/withdrawals/:id', adminController.processWithdrawal);
router.post('/wallet/adjust', adminController.adjustWalletBalance);
router.get('/wallet/transactions/:userId', adminController.getUserTransactions);

// System Configuration & Bulk Queue
router.get('/system/config', adminController.getSystemConfig);
router.put('/system/config', adminController.updateSystemConfig);
router.get('/system/bulk-jobs', adminController.getBulkJobs);

// Broadcast & Communication
router.post('/broadcast', adminController.broadcastNotification);

// Compliance & Audit Logs
router.get('/audit-logs', adminController.getAuditLogs);

// Data Export (JSON & CSV)
router.get('/export/:type', adminController.exportData);

module.exports = router;
