const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

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

const User = loadMod('models', 'User');
const Shipment = loadMod('models', 'Shipment');
const Claim = loadMod('models', 'Claim');
const Notification = loadMod('models', 'Notification');
const AuditLog = loadMod('models', 'AuditLog');
const Reward = loadMod('models', 'Reward');
const BulkJob = loadMod('models', 'BulkJob');
const SystemConfig = loadMod('models', 'SystemConfig');
const CarrierJourney = loadMod('models', 'CarrierJourney');
const { createNotification } = loadMod('services', 'notification');

// Helper to record an audit log entry
const logAudit = async (req, action, targetType, targetId, details) => {
  try {
    const adminEmail = req.user?.email || 'admin@securekaro.in';
    const adminId = req.user?._id || null;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';

    await AuditLog.create({
      adminId,
      adminEmail,
      action,
      targetType,
      targetId: String(targetId || ''),
      details: details || {},
      ipAddress
    });
  } catch (err) {
    console.error('Audit Log Error:', err.message);
  }
};

/**
 * @desc    Get Admin Overview Analytics & Health
 * @route   GET /api/v1/admin/analytics
 * @access  Private (Admin)
 */
const getAnalyticsDashboard = async (req, res) => {
  try {
    const [
      totalUsers,
      totalSuppliers,
      totalReceivers,
      suspendedUsers,
      proUsers,
      totalShipments,
      shipmentStatusCounts,
      financialAggregates,
      openClaimsCount,
      recentShipments,
      recentAuditLogs
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: 'Supplier' }),
      User.countDocuments({ role: { $in: ['Receiver', 'User'] } }),
      User.countDocuments({ isSuspended: true }),
      User.countDocuments({ isPro: true }),
      Shipment.countDocuments({}),
      Shipment.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } }
      ]),
      Shipment.aggregate([
        {
          $group: {
            _id: null,
            totalGmv: { $sum: '$amount' },
            totalReleasedPrincipal: { $sum: '$principalDisbursedToSupplier' },
            totalGatewayFees: { $sum: '$gatewayFeeDeducted' },
            escrowHeld: {
              $sum: {
                $cond: [
                  { 
                    $and: [
                      { $in: ['$status', ['Created', 'Funded', 'Dispatched', 'In Transit', 'Reached Destination Hub', 'Out for Delivery', 'Delivered', 'Return Requested', 'Locked']] },
                      { $gte: ['$escrowStage', 2] },
                      { $lt: ['$escrowStage', 6] }
                    ]
                  },
                  '$amount',
                  0
                ]
              }
            }
          }
        }
      ]),
      Claim.countDocuments({ status: 'Under Review' }),
      Shipment.find({})
        .sort({ createdAt: -1 })
        .limit(6)
        .populate('senderId', 'fullName email phone')
        .lean(),
      AuditLog.find({})
        .sort({ createdAt: -1 })
        .limit(8)
        .lean()
    ]);

    // Format status counts map
    const statusMap = {};
    shipmentStatusCounts.forEach(item => {
      statusMap[item._id] = { count: item.count, amount: item.totalAmount };
    });

    const fin = financialAggregates[0] || {
      totalGmv: 0,
      totalReleasedPrincipal: 0,
      totalGatewayFees: 0,
      escrowHeld: 0
    };

    // Calculate total user wallet liabilities
    const walletLiabilityResult = await User.aggregate([
      { $group: { _id: null, totalWallet: { $sum: '$walletBalance' }, totalCashback: { $sum: '$cashbackBalance' } } }
    ]);
    const walletLiabilities = walletLiabilityResult[0] || { totalWallet: 0, totalCashback: 0 };

    res.json({
      success: true,
      users: {
        total: totalUsers,
        suppliers: totalSuppliers,
        receivers: totalReceivers,
        suspended: suspendedUsers,
        pro: proUsers
      },
      shipments: {
        total: totalShipments,
        statusBreakdown: statusMap,
        activeEscrows: (statusMap['Funded']?.count || 0) + 
                       (statusMap['Dispatched']?.count || 0) + 
                       (statusMap['In Transit']?.count || 0) + 
                       (statusMap['Delivered']?.count || 0) + 
                       (statusMap['Return Requested']?.count || 0) +
                       (statusMap['Locked']?.count || 0),
        disputedCount: statusMap['Locked']?.count || 0,
        releasedCount: statusMap['Released']?.count || 0,
        refundedCount: statusMap['Refunded']?.count || (statusMap['Cancelled']?.count || 0)
      },
      financials: {
        totalGmv: fin.totalGmv || 0,
        escrowInCustody: fin.escrowHeld || 0,
        totalDisbursedToSellers: fin.totalReleasedPrincipal || 0,
        platformFeeCollected: fin.totalGatewayFees || 0,
        userWalletLiabilities: walletLiabilities.totalWallet || 0,
        userCashbackLiabilities: walletLiabilities.totalCashback || 0
      },
      disputes: {
        openClaimsCount
      },
      system: {
        uptimeSeconds: Math.floor(process.uptime()),
        carrierMockActive: process.env.CARRIER_TRACKING_MOCK === 'true',
        nodeEnv: process.env.NODE_ENV || 'development',
        dbStatus: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
      },
      recentShipments,
      recentAuditLogs
    });
  } catch (error) {
    console.error('Admin Analytics Error:', error);
    res.status(500).json({ error: 'Failed to retrieve admin analytics', details: error.message });
  }
};

/**
 * @desc    Get all users with search, role filter, pagination
 * @route   GET /api/v1/admin/users
 * @access  Private (Admin)
 */
const getAllUsers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const { search, role, isSuspended, isPro } = req.query;
    const filter = {};

    if (search && search.trim()) {
      const q = search.trim();
      const regex = new RegExp(q, 'i');
      filter.$or = [
        { fullName: regex },
        { email: regex },
        { phone: regex },
        { referralCode: regex }
      ];
    }

    if (role && role !== 'all') {
      if (role === 'Admin') {
        filter.$or = [{ role: 'Admin' }, { isAdmin: true }, { role: 'super_admin' }];
      } else {
        filter.role = role;
      }
    }

    if (isSuspended !== undefined && isSuspended !== '') {
      filter.isSuspended = isSuspended === 'true';
    }

    if (isPro !== undefined && isPro !== '') {
      filter.isPro = isPro === 'true';
    }

    const [totalUsers, usersList] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select('-passwordHash')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    // Enhance each user with shipment counts
    const userIds = usersList.map(u => u._id);
    const shipmentCounts = await Shipment.aggregate([
      { $match: { senderId: { $in: userIds } } },
      { $group: { _id: '$senderId', total: { $sum: 1 }, gmv: { $sum: '$amount' } } }
    ]);

    const countMap = {};
    shipmentCounts.forEach(c => {
      countMap[c._id.toString()] = { count: c.total, gmv: c.gmv };
    });

    const enrichedUsers = usersList.map(u => ({
      ...u,
      shipmentCount: countMap[u._id.toString()]?.count || 0,
      totalGmv: countMap[u._id.toString()]?.gmv || 0
    }));

    res.json({
      success: true,
      total: totalUsers,
      page,
      limit,
      totalPages: Math.ceil(totalUsers / limit),
      users: enrichedUsers
    });
  } catch (error) {
    console.error('Admin GetAllUsers Error:', error);
    res.status(500).json({ error: 'Failed to retrieve users', details: error.message });
  }
};

/**
 * @desc    Get detailed user information + activity
 * @route   GET /api/v1/admin/users/:id
 * @access  Private (Admin)
 */
const getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-passwordHash').lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [sentShipments, claimsFiled, auditHistory] = await Promise.all([
      Shipment.find({ senderId: user._id }).sort({ createdAt: -1 }).limit(20).lean(),
      Claim.find({ filedBy: user._id }).sort({ createdAt: -1 }).lean(),
      AuditLog.find({ targetId: user._id.toString() }).sort({ createdAt: -1 }).limit(15).lean()
    ]);

    res.json({
      success: true,
      user,
      activity: {
        sentShipments,
        claimsFiled,
        auditHistory
      }
    });
  } catch (error) {
    console.error('Admin GetUserById Error:', error);
    res.status(500).json({ error: 'Failed to retrieve user details', details: error.message });
  }
};

/**
 * @desc    Suspend or Ban a User
 * @route   PUT /api/v1/admin/users/:id/suspend
 * @access  Private (Admin)
 */
const suspendUser = async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.email === 'kartickdas6289@gmail.com') {
      return res.status(403).json({ error: 'Cannot suspend primary Super Admin account' });
    }

    user.isSuspended = true;
    user.suspendedReason = (reason && reason.trim()) || 'Administrative suspension: Terms violation / Suspicious activity';
    user.suspendedAt = new Date();
    await user.save();

    await logAudit(req, 'SUSPEND_USER', 'User', user._id, {
      userEmail: user.email,
      fullName: user.fullName,
      reason: user.suspendedReason
    });

    // Notify user
    await createNotification(
      user._id,
      'gavel',
      'Account Suspended',
      `Your account has been restricted by platform administration. Reason: ${user.suspendedReason}. Contact support@securekaro.in for assistance.`,
      'alert'
    );

    res.json({
      success: true,
      message: `User ${user.email} suspended successfully`,
      user: {
        id: user._id,
        email: user.email,
        isSuspended: user.isSuspended,
        suspendedReason: user.suspendedReason,
        suspendedAt: user.suspendedAt
      }
    });
  } catch (error) {
    console.error('Admin SuspendUser Error:', error);
    res.status(500).json({ error: 'Failed to suspend user', details: error.message });
  }
};

/**
 * @desc    Unsuspend / Re-activate User
 * @route   PUT /api/v1/admin/users/:id/unsuspend
 * @access  Private (Admin)
 */
const unsuspendUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.isSuspended = false;
    user.suspendedReason = '';
    user.suspendedAt = null;
    await user.save();

    await logAudit(req, 'UNSUSPEND_USER', 'User', user._id, {
      userEmail: user.email,
      fullName: user.fullName
    });

    // Notify user
    await createNotification(
      user._id,
      'verified',
      'Account Re-activated',
      'Your SecureKaro account privileges have been restored. You may now continue transacting securely.',
      'confirmed'
    );

    res.json({
      success: true,
      message: `User ${user.email} reactivated successfully`,
      user: {
        id: user._id,
        email: user.email,
        isSuspended: user.isSuspended
      }
    });
  } catch (error) {
    console.error('Admin UnsuspendUser Error:', error);
    res.status(500).json({ error: 'Failed to unsuspend user', details: error.message });
  }
};

/**
 * @desc    Update User Role or Administrative Privileges
 * @route   PUT /api/v1/admin/users/:id/role
 * @access  Private (Super Admin)
 */
const updateUserRole = async (req, res) => {
  try {
    const { role, isAdmin, adminRole, isPro } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const prevRole = { role: user.role, isAdmin: user.isAdmin, adminRole: user.adminRole, isPro: user.isPro };

    if (role && ['User', 'Supplier', 'Receiver', 'Admin', 'super_admin'].includes(role)) {
      user.role = role;
    }

    if (isAdmin !== undefined) {
      user.isAdmin = Boolean(isAdmin);
      if (user.isAdmin && !user.adminRole) {
        user.adminRole = 'operations_admin';
      }
    }

    if (adminRole !== undefined) {
      user.adminRole = adminRole;
      if (adminRole) {
        user.isAdmin = true;
      }
    }

    if (isPro !== undefined) {
      user.isPro = Boolean(isPro);
      user.proPlan = user.isPro ? 'Pro' : 'Standard';
      if (user.isPro) user.proUpgradedAt = new Date();
    }

    await user.save();

    await logAudit(req, 'UPDATE_USER_ROLE', 'User', user._id, {
      userEmail: user.email,
      previous: prevRole,
      updated: { role: user.role, isAdmin: user.isAdmin, adminRole: user.adminRole, isPro: user.isPro }
    });

    res.json({
      success: true,
      message: `User role/privileges updated for ${user.email}`,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        isAdmin: user.isAdmin,
        adminRole: user.adminRole,
        isPro: user.isPro
      }
    });
  } catch (error) {
    console.error('Admin UpdateUserRole Error:', error);
    res.status(500).json({ error: 'Failed to update user role', details: error.message });
  }
};

/**
 * @desc    Get All Shipments with comprehensive filters & pagination
 * @route   GET /api/v1/admin/shipments
 * @access  Private (Admin)
 */
const getAllShipments = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const { search, status, carrier, isDisputed, minAmount, maxAmount } = req.query;
    const filter = {};

    if (search && search.trim()) {
      const q = search.trim();
      const regex = new RegExp(q, 'i');
      filter.$or = [
        { shipmentId: regex },
        { trackingNumber: regex },
        { receiverName: regex },
        { receiverPhone: regex },
        { receiverCity: regex },
        { itemDescription: regex }
      ];
    }

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (carrier && carrier !== 'all') {
      filter.carrierName = carrier;
    }

    if (isDisputed === 'true') {
      filter.$or = [
        { status: 'Locked' },
        { escrowStage: -1 }
      ];
    }

    if (minAmount || maxAmount) {
      filter.amount = {};
      if (minAmount) filter.amount.$gte = Number(minAmount);
      if (maxAmount) filter.amount.$lte = Number(maxAmount);
    }

    const [totalShipments, shipments] = await Promise.all([
      Shipment.countDocuments(filter),
      Shipment.find(filter)
        .populate('senderId', 'fullName email phone isPro')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    res.json({
      success: true,
      total: totalShipments,
      page,
      limit,
      totalPages: Math.ceil(totalShipments / limit),
      shipments
    });
  } catch (error) {
    console.error('Admin GetAllShipments Error:', error);
    res.status(500).json({ error: 'Failed to retrieve shipments', details: error.message });
  }
};

/**
 * @desc    Admin Shipment Status Manual Override
 * @route   PUT /api/v1/admin/shipments/:id/override-status
 * @access  Private (Admin)
 */
const overrideShipmentStatus = async (req, res) => {
  try {
    const { newStatus, notes } = req.body;
    const shipment = await Shipment.findOne({
      $or: [
        { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null },
        { shipmentId: req.params.id.toUpperCase() }
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    const oldStatus = shipment.status;
    shipment.status = newStatus;

    if (newStatus === 'Delivered') {
      shipment.deliveryDate = new Date();
      shipment.deliveredAt = new Date();
      shipment.escrowStage = Math.max(shipment.escrowStage, 4);
      // Auto-set confirmation window (24h)
      if (!shipment.confirmationWindowExpiresAt) {
        shipment.confirmationWindowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      }
    } else if (newStatus === 'In Transit') {
      shipment.escrowStage = Math.max(shipment.escrowStage, 3);
    } else if (newStatus === 'Released') {
      shipment.escrowStage = 6;
      shipment.principalDisbursedToSupplier = shipment.amount;
      shipment.confirmationWindowClosed = true;
    } else if (newStatus === 'Refunded' || newStatus === 'Cancelled') {
      shipment.escrowStage = -2;
    }

    await shipment.save();

    await logAudit(req, 'STATUS_OVERRIDE', 'Shipment', shipment.shipmentId, {
      oldStatus,
      newStatus,
      notes: notes || 'Admin manual status override'
    });

    // Notify parties
    const notifyMsg = `Administrative status update for order #${shipment.shipmentId}: changed from "${oldStatus}" to "${newStatus}". Notes: ${notes || 'Updated by Operations Team'}`;
    await createNotification(shipment.senderId, 'sync', `Status Override: ${shipment.shipmentId}`, notifyMsg, 'shipping', shipment.shipmentId);

    // If receiver user exists, notify receiver as well
    const receiver = await User.findOne({ phone: shipment.receiverPhone });
    if (receiver) {
      await createNotification(receiver._id, 'sync', `Status Override: ${shipment.shipmentId}`, notifyMsg, 'shipping', shipment.shipmentId);
    }

    res.json({
      success: true,
      message: `Shipment #${shipment.shipmentId} status updated to ${newStatus}`,
      shipment
    });
  } catch (error) {
    console.error('Admin OverrideShipmentStatus Error:', error);
    res.status(500).json({ error: 'Failed to override status', details: error.message });
  }
};

/**
 * @desc    Force Release Escrow Principal to Supplier (Master Admin Key)
 * @route   POST /api/v1/admin/shipments/:id/force-release
 * @access  Private (Admin)
 */
const forceReleaseEscrow = async (req, res) => {
  try {
    const { reason } = req.body;
    const shipment = await Shipment.findOne({
      $or: [
        { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null },
        { shipmentId: req.params.id.toUpperCase() }
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    if (shipment.escrowStage === 6 && shipment.status === 'Released') {
      return res.status(400).json({ error: 'Escrow principal has already been disbursed' });
    }

    const principal = Number(shipment.amount) || 0;
    const previousStatus = shipment.status;

    // Force unlock and release
    shipment.status = 'Released';
    shipment.escrowStage = 6;
    shipment.principalDisbursedToSupplier = principal;
    // NOTE: Do NOT zero gatewayFeeDeducted / gatewayFeeRate here.
    // Those are historical records of what was originally charged and must
    // be preserved for the financial audit trail. The full principal is
    // credited to the supplier regardless of any fee waiver decision.
    shipment.confirmationWindowClosed = true;
    shipment.withdrawableAt = new Date();
    await shipment.save();

    // Credit supplier wallet balance if seller exists
    const supplier = await User.findById(shipment.senderId);
    if (supplier) {
      supplier.walletBalance = (supplier.walletBalance || 0) + principal;
      await supplier.save();
    }

    // If there were any active claims for this shipment, mark them resolved
    await Claim.updateMany(
      { shipmentId: shipment.shipmentId, status: 'Under Review' },
      { 
        status: 'Rejected',
        arbitratorNotes: `Force released by Admin: ${reason || 'Decision in favor of merchant. Escrow disbursed.'}` 
      }
    );

    await logAudit(req, 'FORCE_RELEASE_ESCROW', 'Shipment', shipment.shipmentId, {
      principal,
      previousStatus,
      reason: reason || 'Admin executive force release override',
      supplierEmail: supplier?.email
    });

    const formattedAmount = `₹${new Intl.NumberFormat('en-IN').format(principal)}`;

    // Create notifications
    if (supplier) {
      await createNotification(
        supplier._id,
        'payments',
        `Admin Force-Release Cleared: ${shipment.shipmentId}`,
        `Administrative resolution: Escrow funds of ${formattedAmount} for order #${shipment.shipmentId} have been disbursed to your wallet. Reason: ${reason || 'Executive release approved'}.`,
        'payment',
        shipment.shipmentId
      );
    }

    const receiver = await User.findOne({ phone: shipment.receiverPhone });
    if (receiver) {
      await createNotification(
        receiver._id,
        'info',
        `Escrow Settled: ${shipment.shipmentId}`,
        `Order #${shipment.shipmentId} escrow (${formattedAmount}) was finalized and disbursed to the merchant after administrative review. Reason: ${reason || 'Resolution complete'}.`,
        'confirmed',
        shipment.shipmentId
      );
    }

    res.json({
      success: true,
      message: `Escrow for #${shipment.shipmentId} successfully force-released (${formattedAmount})`,
      shipment
    });
  } catch (error) {
    console.error('Admin ForceReleaseEscrow Error:', error);
    res.status(500).json({ error: 'Failed to force release escrow', details: error.message });
  }
};

/**
 * @desc    Force Refund Escrow Principal to Buyer (Master Admin Key)
 * @route   POST /api/v1/admin/shipments/:id/force-refund
 * @access  Private (Admin)
 */
const forceRefundEscrow = async (req, res) => {
  try {
    const { reason } = req.body;
    const shipment = await Shipment.findOne({
      $or: [
        { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null },
        { shipmentId: req.params.id.toUpperCase() }
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    if (shipment.status === 'Refunded' || shipment.escrowStage === -2) {
      return res.status(400).json({ error: 'Shipment has already been refunded' });
    }

    const principal = Number(shipment.amount) || 0;
    const previousStatus = shipment.status;

    // Force refund status
    shipment.status = 'Refunded';
    shipment.escrowStage = -2;
    await shipment.save();

    // Credit receiver wallet if registered
    let receiver = await User.findOne({ phone: shipment.receiverPhone });
    if (!receiver && shipment.receiverPhone) {
      const sanitized = shipment.receiverPhone.replace(/\D/g, '').slice(-10);
      receiver = await User.findOne({
        $or: [{ phone: sanitized }, { phone: `+91${sanitized}` }]
      });
    }

    if (receiver) {
      receiver.walletBalance = (receiver.walletBalance || 0) + principal;
      await receiver.save();
    }

    // Mark active claims as Approved for buyer
    await Claim.updateMany(
      { shipmentId: shipment.shipmentId, status: 'Under Review' },
      { 
        status: 'Approved',
        arbitratorNotes: `Force refunded to buyer by Admin: ${reason || 'Claim upheld. 100% refund credited.'}` 
      }
    );

    await logAudit(req, 'FORCE_REFUND_ESCROW', 'Shipment', shipment.shipmentId, {
      principal,
      previousStatus,
      reason: reason || 'Admin executive force refund override',
      receiverPhone: shipment.receiverPhone,
      receiverCredited: !!receiver
    });

    const formattedAmount = `₹${new Intl.NumberFormat('en-IN').format(principal)}`;

    // Notify Receiver
    if (receiver) {
      await createNotification(
        receiver._id,
        'verified',
        `Admin Force-Refund Cleared: ${shipment.shipmentId}`,
        `Administrative resolution: Full escrow refund of ${formattedAmount} for order #${shipment.shipmentId} has been credited to your wallet balance. Reason: ${reason || 'Claim approved'}.`,
        'payment',
        shipment.shipmentId
      );
    }

    // Notify Supplier
    await createNotification(
      shipment.senderId,
      'alert',
      `Order Refunded: ${shipment.shipmentId}`,
      `Order #${shipment.shipmentId} escrow (${formattedAmount}) was refunded to the buyer following administrative intervention. Reason: ${reason || 'Claim upheld'}.`,
      'alert',
      shipment.shipmentId
    );

    res.json({
      success: true,
      message: `Escrow for #${shipment.shipmentId} successfully refunded (${formattedAmount})`,
      shipment,
      refundedAmount: principal,
      creditedToWallet: !!receiver
    });
  } catch (error) {
    console.error('Admin ForceRefundEscrow Error:', error);
    res.status(500).json({ error: 'Failed to force refund escrow', details: error.message });
  }
};

/**
 * @desc    Get All Dispute Claims & Locked Escrows
 * @route   GET /api/v1/admin/disputes
 * @access  Private (Admin)
 */
const getAllDisputes = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status && status !== 'all') {
      filter.status = status;
    }

    const claims = await Claim.find(filter)
      .populate('filedBy', 'fullName email phone role')
      .sort({ createdAt: -1 })
      .lean();

    // Map shipment details for each claim
    const shipmentIds = claims.map(c => c.shipmentId);
    const shipments = await Shipment.find({ shipmentId: { $in: shipmentIds } })
      .populate('senderId', 'fullName email phone')
      .lean();

    const shipmentMap = {};
    shipments.forEach(s => {
      shipmentMap[s.shipmentId] = s;
    });

    const enrichedClaims = claims.map(c => ({
      ...c,
      shipment: shipmentMap[c.shipmentId] || null
    }));

    // Also find any shipments locked without an explicit claim
    const lockedShipments = await Shipment.find({
      $or: [{ status: 'Locked' }, { escrowStage: -1 }],
      shipmentId: { $nin: shipmentIds }
    })
      .populate('senderId', 'fullName email phone')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      totalClaims: enrichedClaims.length,
      claims: enrichedClaims,
      unclaimedLockedShipments: lockedShipments
    });
  } catch (error) {
    console.error('Admin GetAllDisputes Error:', error);
    res.status(500).json({ error: 'Failed to retrieve disputes', details: error.message });
  }
};

/**
 * @desc    Resolve Dispute / Arbitration
 * @route   POST /api/v1/admin/disputes/:id/resolve
 * @access  Private (Admin)
 */
const resolveDispute = async (req, res) => {
  try {
    const { decision, arbitratorNotes, splitSupplierAmount, splitReceiverAmount } = req.body;
    const claim = await Claim.findById(req.params.id);

    if (!claim) {
      return res.status(404).json({ error: 'Dispute claim not found' });
    }

    const shipment = await Shipment.findOne({ shipmentId: claim.shipmentId.toUpperCase() });
    if (!shipment) {
      return res.status(404).json({ error: 'Associated shipment not found' });
    }

    const principal = Number(shipment.amount) || 0;
    const notes = arbitratorNotes || `Arbitration resolved in favor of ${decision}`;

    if (decision === 'favor_seller') {
      claim.status = 'Rejected'; // Buyer's claim rejected
      claim.arbitratorNotes = notes;
      await claim.save();

      shipment.status = 'Released';
      shipment.escrowStage = 6;
      shipment.principalDisbursedToSupplier = principal;
      shipment.confirmationWindowClosed = true;
      await shipment.save();

      // Credit supplier
      const supplier = await User.findById(shipment.senderId);
      if (supplier) {
        supplier.walletBalance = (supplier.walletBalance || 0) + principal;
        await supplier.save();
      }

      await logAudit(req, 'RESOLVE_DISPUTE', 'Claim', claim.claimId, {
        decision: 'favor_seller',
        shipmentId: shipment.shipmentId,
        amount: principal,
        notes
      });

      await createNotification(
        shipment.senderId,
        'gavel',
        `Dispute Resolved in Your Favor: ${shipment.shipmentId}`,
        `Platform arbitrator ruled in your favor for #${shipment.shipmentId}. Escrow of ₹${principal} released to your wallet. Notes: ${notes}`,
        'payment',
        shipment.shipmentId
      );

      let receiver = await User.findOne({ phone: shipment.receiverPhone });
      if (!receiver && shipment.receiverPhone) {
        const sanitized = shipment.receiverPhone.replace(/\D/g, '').slice(-10);
        receiver = await User.findOne({
          $or: [{ phone: sanitized }, { phone: `+91${sanitized}` }]
        });
      }
      if (receiver) {
        await createNotification(
          receiver._id,
          'gavel',
          `Dispute Decision: ${shipment.shipmentId}`,
          `Your claim for #${shipment.shipmentId} was reviewed and closed by the arbitration team. Arbitrator Notes: ${notes}`,
          'alert',
          shipment.shipmentId
        );
      }
    } else if (decision === 'favor_buyer') {
      claim.status = 'Approved';
      claim.arbitratorNotes = notes;
      await claim.save();

      shipment.status = 'Refunded';
      shipment.escrowStage = -2;
      await shipment.save();

      // Credit receiver
      let receiver = await User.findOne({ phone: shipment.receiverPhone });
      if (!receiver && shipment.receiverPhone) {
        const sanitized = shipment.receiverPhone.replace(/\D/g, '').slice(-10);
        receiver = await User.findOne({
          $or: [{ phone: sanitized }, { phone: `+91${sanitized}` }]
        });
      }

      if (receiver) {
        receiver.walletBalance = (receiver.walletBalance || 0) + principal;
        await receiver.save();
      }

      await logAudit(req, 'RESOLVE_DISPUTE', 'Claim', claim.claimId, {
        decision: 'favor_buyer',
        shipmentId: shipment.shipmentId,
        amount: principal,
        notes
      });

      if (receiver) {
        await createNotification(
          receiver._id,
          'gavel',
          `Dispute Upheld — Refund Issued: ${shipment.shipmentId}`,
          `Platform arbitrator ruled in your favor for claim #${claim.claimId}. Full refund of ₹${principal} credited to your wallet. Notes: ${notes}`,
          'payment',
          shipment.shipmentId
        );
      }

      await createNotification(
        shipment.senderId,
        'gavel',
        `Dispute Decision: ${shipment.shipmentId}`,
        `Claim #${claim.claimId} on parcel #${shipment.shipmentId} was upheld in favor of the buyer. Escrow funds refunded. Notes: ${notes}`,
        'alert',
        shipment.shipmentId
      );
    } else if (decision === 'split') {
      const sellerAmt = Number(splitSupplierAmount) || 0;
      const buyerAmt = Number(splitReceiverAmount) || 0;

      if (sellerAmt + buyerAmt > principal) {
        return res.status(400).json({ error: `Split amounts (₹${sellerAmt + buyerAmt}) exceed total principal (₹${principal})` });
      }

      claim.status = 'Approved';
      claim.arbitratorNotes = `Split Settlement: ₹${sellerAmt} to Seller, ₹${buyerAmt} to Buyer. ${notes}`;
      await claim.save();

      shipment.status = 'Released';
      shipment.escrowStage = 6;
      shipment.principalDisbursedToSupplier = sellerAmt;
      await shipment.save();

      // Credit supplier
      const supplier = await User.findById(shipment.senderId);
      if (supplier && sellerAmt > 0) {
        supplier.walletBalance = (supplier.walletBalance || 0) + sellerAmt;
        await supplier.save();
      }

      // Credit receiver — normalize phone format (same logic as favor_buyer case)
      let receiver = await User.findOne({ phone: shipment.receiverPhone });
      if (!receiver && shipment.receiverPhone) {
        const sanitized = shipment.receiverPhone.replace(/\D/g, '').slice(-10);
        receiver = await User.findOne({
          $or: [{ phone: sanitized }, { phone: `+91${sanitized}` }]
        });
      }
      if (receiver && buyerAmt > 0) {
        receiver.walletBalance = (receiver.walletBalance || 0) + buyerAmt;
        await receiver.save();
      }

      await logAudit(req, 'RESOLVE_DISPUTE', 'Claim', claim.claimId, {
        decision: 'split',
        shipmentId: shipment.shipmentId,
        splitSupplierAmount: sellerAmt,
        splitReceiverAmount: buyerAmt,
        notes
      });

      if (supplier) {
        await createNotification(
          supplier._id,
          'gavel',
          `Dispute Split Settlement: ${shipment.shipmentId}`,
          `Arbitration reached a split settlement for #${shipment.shipmentId}. You received ₹${sellerAmt}. Notes: ${notes}`,
          'payment',
          shipment.shipmentId
        );
      }

      if (receiver) {
        await createNotification(
          receiver._id,
          'gavel',
          `Dispute Split Settlement: ${shipment.shipmentId}`,
          `Arbitration reached a split settlement for #${shipment.shipmentId}. You were refunded ₹${buyerAmt}. Notes: ${notes}`,
          'payment',
          shipment.shipmentId
        );
      }
    } else {
      return res.status(400).json({ error: 'Invalid decision type. Choose: favor_seller, favor_buyer, or split' });
    }

    res.json({
      success: true,
      message: `Dispute claim #${claim.claimId} resolved (${decision})`,
      claim,
      shipment
    });
  } catch (error) {
    console.error('Admin ResolveDispute Error:', error);
    res.status(500).json({ error: 'Failed to resolve dispute', details: error.message });
  }
};

/**
 * @desc    Get Detailed Financial Ledger & Monthly Volumes
 * @route   GET /api/v1/admin/finance/summary
 * @access  Private (Admin)
 */
const getFinancialSummary = async (req, res) => {
  try {
    const [monthlyAggregates, topSuppliers, totalWalletHoldings] = await Promise.all([
      Shipment.aggregate([
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' }
            },
            gmv: { $sum: '$amount' },
            count: { $sum: 1 },
            released: { $sum: '$principalDisbursedToSupplier' },
            fees: { $sum: '$gatewayFeeDeducted' }
          }
        },
        { $sort: { '_id.year': -1, '_id.month': -1 } },
        { $limit: 12 }
      ]),
      Shipment.aggregate([
        { $group: { _id: '$senderId', gmv: { $sum: '$amount' }, ordersCount: { $sum: 1 } } },
        { $sort: { gmv: -1 } },
        { $limit: 8 },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'supplierInfo'
          }
        },
        { $unwind: { path: '$supplierInfo', preserveNullAndEmptyArrays: true } }
      ]),
      User.aggregate([
        {
          $group: {
            _id: null,
            totalWalletBalance: { $sum: '$walletBalance' },
            totalCashbackBalance: { $sum: '$cashbackBalance' },
            totalReferralCredits: { $sum: '$referralCredits' }
          }
        }
      ])
    ]);

    res.json({
      success: true,
      monthlyBreakdown: monthlyAggregates,
      topSuppliers: topSuppliers.map(s => ({
        supplierId: s._id,
        fullName: s.supplierInfo?.fullName || 'Unknown Merchant',
        email: s.supplierInfo?.email || '',
        phone: s.supplierInfo?.phone || '',
        isPro: s.supplierInfo?.isPro || false,
        gmv: s.gmv,
        ordersCount: s.ordersCount
      })),
      walletHoldings: totalWalletHoldings[0] || {
        totalWalletBalance: 0,
        totalCashbackBalance: 0,
        totalReferralCredits: 0
      }
    });
  } catch (error) {
    console.error('Admin FinancialSummary Error:', error);
    res.status(500).json({ error: 'Failed to retrieve financial summary', details: error.message });
  }
};

/**
 * @desc    Adjust User Wallet Balance (Credit or Debit with Audit Trail)
 * @route   POST /api/v1/admin/wallet/adjust
 * @access  Private (Admin)
 */
const adjustWalletBalance = async (req, res) => {
  try {
    const { userId, type, amount, reason } = req.body;
    const numAmount = Number(amount);

    if (!userId || !type || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Valid userId, type (credit|debit), and positive amount required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const prevBalance = user.walletBalance || 0;
    if (type === 'debit' && prevBalance < numAmount) {
      return res.status(400).json({ error: `Cannot debit ₹${numAmount}. User wallet balance is only ₹${prevBalance}.` });
    }

    const newBalance = type === 'credit' ? prevBalance + numAmount : prevBalance - numAmount;
    user.walletBalance = newBalance;
    await user.save();

    await logAudit(req, 'WALLET_ADJUST', 'Wallet', user._id, {
      userEmail: user.email,
      fullName: user.fullName,
      adjustmentType: type,
      amount: numAmount,
      prevBalance,
      newBalance,
      reason: reason || 'Administrative balance adjustment'
    });

    // Notify user
    const fmtAmt = `₹${new Intl.NumberFormat('en-IN').format(numAmount)}`;
    const fmtBal = `₹${new Intl.NumberFormat('en-IN').format(newBalance)}`;
    await createNotification(
      user._id,
      'wallet',
      `Wallet Balance ${type === 'credit' ? 'Credited' : 'Debited'}: ${fmtAmt}`,
      `Your SecureKaro wallet has been ${type === 'credit' ? 'credited with' : 'debited by'} ${fmtAmt}. Current balance: ${fmtBal}. Reason: ${reason || 'Administrative adjustment'}.`,
      'payment'
    );

    res.json({
      success: true,
      message: `Successfully ${type === 'credit' ? 'credited' : 'debited'} ${fmtAmt} for ${user.email}`,
      user: {
        id: user._id,
        email: user.email,
        walletBalance: user.walletBalance
      }
    });
  } catch (error) {
    console.error('Admin AdjustWallet Error:', error);
    res.status(500).json({ error: 'Failed to adjust wallet balance', details: error.message });
  }
};

/**
 * @desc    Broadcast Notification to Platform Users
 * @route   POST /api/v1/admin/broadcast
 * @access  Private (Admin)
 */
const broadcastNotification = async (req, res) => {
  try {
    const { title, message, targetRole, icon, type } = req.body;

    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required for broadcast' });
    }

    const filter = {};
    if (targetRole && targetRole !== 'all') {
      filter.role = targetRole;
    }

    const targetUsers = await User.find(filter, '_id');
    const userIds = targetUsers.map(u => u._id);

    const notificationDocs = userIds.map(uid => ({
      userId: uid,
      icon: icon || 'campaign',
      title: title.trim(),
      message: message.trim(),
      type: type || 'alert',
      read: false,
      createdAt: new Date()
    }));

    if (notificationDocs.length > 0) {
      await Notification.insertMany(notificationDocs);
    }

    await logAudit(req, 'BROADCAST_NOTIFICATION', 'Broadcast', targetRole || 'all', {
      title,
      message,
      targetRole: targetRole || 'all',
      recipientsCount: notificationDocs.length
    });

    res.json({
      success: true,
      message: `Broadcast message sent to ${notificationDocs.length} users successfully`,
      recipientsCount: notificationDocs.length
    });
  } catch (error) {
    console.error('Admin BroadcastNotification Error:', error);
    res.status(500).json({ error: 'Failed to broadcast notification', details: error.message });
  }
};

/**
 * @desc    Get Compliance & Administrative Audit Logs
 * @route   GET /api/v1/admin/audit-logs
 * @access  Private (Admin)
 */
const getAuditLogs = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const skip = (page - 1) * limit;

    const { action, targetType, search } = req.query;
    const filter = {};

    if (action && action !== 'all') {
      filter.action = action.toUpperCase();
    }

    if (targetType && targetType !== 'all') {
      filter.targetType = targetType;
    }

    if (search && search.trim()) {
      const q = search.trim();
      const regex = new RegExp(q, 'i');
      filter.$or = [
        { adminEmail: regex },
        { targetId: regex }
      ];
    }

    const [totalLogs, logs] = await Promise.all([
      AuditLog.countDocuments(filter),
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    res.json({
      success: true,
      total: totalLogs,
      page,
      limit,
      totalPages: Math.ceil(totalLogs / limit),
      logs
    });
  } catch (error) {
    console.error('Admin GetAuditLogs Error:', error);
    res.status(500).json({ error: 'Failed to retrieve audit logs', details: error.message });
  }
};

/**
 * CSV serialization helper
 */
const convertToCSV = (items, fields) => {
  if (!items || !items.length) return '';
  const header = fields.map(f => `"${String(f.label).replace(/"/g, '""')}"`).join(',');
  const rows = items.map(item => {
    return fields.map(f => {
      let val = f.getter ? f.getter(item) : item[f.key];
      if (val === null || val === undefined) val = '';
      if (val instanceof Date) val = val.toISOString();
      if (typeof val === 'object') val = JSON.stringify(val);
      val = String(val).replace(/"/g, '""');
      return `"${val}"`;
    }).join(',');
  });
  return [header, ...rows].join('\r\n');
};

/**
 * @desc    Get Detailed Single Shipment (Escrow, Ledger, Claims & Tracking)
 * @route   GET /api/v1/admin/shipments/:id
 * @access  Private (Admin)
 */
const getSingleShipment = async (req, res) => {
  try {
    const { id } = req.params;
    let shipment = null;

    if (mongoose.Types.ObjectId.isValid(id)) {
      shipment = await Shipment.findById(id).populate('senderId', 'fullName email phone address city state pincode bankDetails walletBalance').lean();
    }
    if (!shipment) {
      shipment = await Shipment.findOne({ shipmentId: id.toUpperCase() }).populate('senderId', 'fullName email phone address city state pincode bankDetails walletBalance').lean();
    }

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    const [claims, journeys] = await Promise.all([
      Claim.find({ shipmentId: shipment.shipmentId }).populate('filedBy', 'fullName email phone').sort({ createdAt: -1 }).lean(),
      CarrierJourney ? CarrierJourney.find({ awbCode: shipment.awbCode }).sort({ timestamp: -1 }).lean() : []
    ]);

    res.json({
      success: true,
      shipment,
      claims,
      carrierJourneys: journeys || []
    });
  } catch (error) {
    console.error('Admin getSingleShipment error:', error);
    res.status(500).json({ error: 'Failed to retrieve shipment details', details: error.message });
  }
};

/**
 * @desc    Admin Force Cancel Shipment (and refund buyer if funded)
 * @route   PUT /api/v1/admin/shipments/:id/cancel
 * @access  Private (Admin)
 */
const cancelShipmentAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const shipment = await Shipment.findOne({
      $or: [
        { shipmentId: id.toUpperCase() },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    if (shipment.status === 'Cancelled') {
      return res.status(400).json({ error: 'Shipment is already cancelled' });
    }

    const previousStatus = shipment.status;
    shipment.status = 'Cancelled';
    const wasEscrowHeld = shipment.escrowStage >= 2 && shipment.escrowStage < 6;
    shipment.escrowStage = -1;

    // If escrow was held, refund receiver
    if (wasEscrowHeld && shipment.amount > 0) {
      shipment.principalRefundedToReceiver = (shipment.principalRefundedToReceiver || 0) + shipment.amount;
      const receiver = await User.findOne({
        $or: [
          { phone: shipment.receiverPhone },
          { email: shipment.receiverEmail || '' }
        ]
      });

      if (receiver) {
        receiver.walletBalance = (receiver.walletBalance || 0) + shipment.amount;
        await receiver.save();

        if (Reward) {
          await Reward.create({
            userId: receiver._id,
            shipmentId: shipment.shipmentId,
            type: 'CASHBACK_EARNED',
            category: 'PREPAYMENT_REWARD',
            role: 'Receiver',
            amount: shipment.amount,
            status: 'CREDITED',
            description: `Admin cancelled order refund for shipment ${shipment.shipmentId}`
          });
        }
      }
    }

    await shipment.save();

    await logAudit(req, 'CANCEL_SHIPMENT', 'Shipment', shipment.shipmentId, {
      previousStatus,
      reason: reason || 'Cancelled by Admin',
      refundedAmount: wasEscrowHeld ? shipment.amount : 0
    });

    if (shipment.senderId) {
      await createNotification(
        shipment.senderId,
        'Shipment Cancelled by Admin',
        `Shipment ${shipment.shipmentId} was cancelled by administrator. Reason: ${reason || 'Administrative action'}`,
        'alert'
      );
    }

    res.json({
      success: true,
      message: `Shipment ${shipment.shipmentId} cancelled successfully.`,
      shipment
    });
  } catch (error) {
    console.error('Admin cancelShipment error:', error);
    res.status(500).json({ error: 'Failed to cancel shipment', details: error.message });
  }
};

/**
 * @desc    Admin Manually Mark Delivery Confirmed
 * @route   PUT /api/v1/admin/shipments/:id/confirm-delivery
 * @access  Private (Admin)
 */
const confirmDeliveryManually = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const shipment = await Shipment.findOne({
      $or: [
        { shipmentId: id.toUpperCase() },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    shipment.status = 'Delivered';
    shipment.escrowStage = 4;
    shipment.inboxQrUsed = true;
    shipment.inboxQrConfirmMethod = 'manual';
    shipment.inboxQrConfirmedAt = new Date();

    await shipment.save();

    await logAudit(req, 'ADMIN_CONFIRM_DELIVERY', 'Shipment', shipment.shipmentId, {
      notes: notes || 'Delivery manually verified and confirmed by Admin'
    });

    if (shipment.senderId) {
      await createNotification(
        shipment.senderId,
        'Delivery Confirmed by Admin',
        `Admin confirmed physical delivery for shipment ${shipment.shipmentId}. Inspection/return window is now running.`,
        'info'
      );
    }

    res.json({
      success: true,
      message: `Delivery confirmed for shipment ${shipment.shipmentId}`,
      shipment
    });
  } catch (error) {
    console.error('Admin confirmDeliveryManually error:', error);
    res.status(500).json({ error: 'Failed to confirm delivery', details: error.message });
  }
};

/**
 * @desc    Toggle Escrow Lock / Freeze
 * @route   PUT /api/v1/admin/shipments/:id/lock
 * @access  Private (Admin)
 */
const toggleShipmentLock = async (req, res) => {
  try {
    const { id } = req.params;
    const { lock, reason } = req.body;

    const shipment = await Shipment.findOne({
      $or: [
        { shipmentId: id.toUpperCase() },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    if (lock) {
      shipment.status = 'Locked';
      shipment.escrowStage = -5;
    } else {
      shipment.status = 'Delivered';
      shipment.escrowStage = 4;
    }

    await shipment.save();

    await logAudit(req, lock ? 'LOCK_ESCROW' : 'UNLOCK_ESCROW', 'Shipment', shipment.shipmentId, {
      reason: reason || (lock ? 'Escrow frozen by admin' : 'Escrow unlocked by admin')
    });

    res.json({
      success: true,
      message: `Escrow ${lock ? 'locked' : 'unlocked'} for shipment ${shipment.shipmentId}`,
      shipment
    });
  } catch (error) {
    console.error('Admin toggleShipmentLock error:', error);
    res.status(500).json({ error: 'Failed to toggle escrow lock', details: error.message });
  }
};

/**
 * @desc    Edit Shipment Data Fields (Receiver, Amount, Route)
 * @route   PUT /api/v1/admin/shipments/:id/edit-details
 * @access  Private (Admin)
 */
const editShipmentDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const { receiverName, receiverPhone, amount, description, city } = req.body;

    const shipment = await Shipment.findOne({
      $or: [
        { shipmentId: id.toUpperCase() },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    const previousData = {
      receiverName: shipment.receiverName,
      receiverPhone: shipment.receiverPhone,
      amount: shipment.amount,
      description: shipment.description,
      city: shipment.city
    };

    if (receiverName !== undefined) shipment.receiverName = String(receiverName).trim();
    if (receiverPhone !== undefined) shipment.receiverPhone = String(receiverPhone).trim();
    if (amount !== undefined && !isNaN(Number(amount))) shipment.amount = Math.max(0, Number(amount));
    if (description !== undefined) shipment.description = String(description).trim();
    if (city !== undefined) shipment.city = String(city).trim();

    await shipment.save();

    await logAudit(req, 'EDIT_SHIPMENT_DETAILS', 'Shipment', shipment.shipmentId, {
      previousData,
      updatedData: {
        receiverName: shipment.receiverName,
        receiverPhone: shipment.receiverPhone,
        amount: shipment.amount,
        description: shipment.description,
        city: shipment.city
      }
    });

    res.json({
      success: true,
      message: `Shipment ${shipment.shipmentId} details updated successfully`,
      shipment
    });
  } catch (error) {
    console.error('Admin editShipmentDetails error:', error);
    res.status(500).json({ error: 'Failed to edit shipment details', details: error.message });
  }
};

/**
 * @desc    Manage In-Box Delivery QR Token (Regenerate or Invalidate)
 * @route   PUT /api/v1/admin/shipments/:id/inbox-qr
 * @access  Private (Admin)
 */
const manageInboxQr = async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // 'regenerate' | 'invalidate'

    const shipment = await Shipment.findOne({
      $or: [
        { shipmentId: id.toUpperCase() },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    if (action === 'regenerate') {
      const newToken = `QR-${Math.random().toString(36).substring(2, 9).toUpperCase()}-${Date.now().toString().slice(-4)}`;
      shipment.inboxQrToken = newToken;
      shipment.inboxQrGeneratedAt = new Date();
      shipment.inboxQrUsed = false;
      shipment.inboxQrConfirmedAt = null;
      await shipment.save();

      await logAudit(req, 'REGENERATE_INBOX_QR', 'Shipment', shipment.shipmentId, { newToken });

      return res.json({
        success: true,
        message: 'In-Box QR token regenerated successfully',
        inboxQrToken: newToken,
        shipment
      });
    } else if (action === 'invalidate') {
      shipment.inboxQrToken = '';
      shipment.inboxQrUsed = true;
      await shipment.save();

      await logAudit(req, 'INVALIDATE_INBOX_QR', 'Shipment', shipment.shipmentId, {});

      return res.json({
        success: true,
        message: 'In-Box QR token invalidated',
        shipment
      });
    } else {
      return res.status(400).json({ error: 'Invalid action. Supported: regenerate, invalidate' });
    }
  } catch (error) {
    console.error('Admin manageInboxQr error:', error);
    res.status(500).json({ error: 'Failed to manage In-Box QR', details: error.message });
  }
};

/**
 * @desc    Get All Return Orders (Admin view)
 * @route   GET /api/v1/admin/returns
 * @access  Private (Admin)
 */
const getAllReturns = async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    const filter = {
      $or: [
        { returnStatus: { $ne: 'None' } },
        { status: { $in: ['Return Requested', 'Return In Transit', 'Returned & Refunded'] } }
      ]
    };

    if (status && status !== 'all') {
      filter.returnStatus = status;
    }

    if (search) {
      const regex = new RegExp(search.trim(), 'i');
      filter.$and = [
        {
          $or: [
            { shipmentId: regex },
            { receiverName: regex },
            { receiverPhone: regex },
            { returnAwbCode: regex },
            { replacementAwbCode: regex }
          ]
        }
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [totalReturns, returns] = await Promise.all([
      Shipment.countDocuments(filter),
      Shipment.find(filter)
        .populate('senderId', 'fullName email phone')
        .sort({ returnRequestedAt: -1, updatedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean()
    ]);

    res.json({
      success: true,
      total: totalReturns,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(totalReturns / Number(limit)),
      returns
    });
  } catch (error) {
    console.error('Admin getAllReturns error:', error);
    res.status(500).json({ error: 'Failed to retrieve return orders', details: error.message });
  }
};

/**
 * @desc    Override Return Status
 * @route   PUT /api/v1/admin/shipments/:id/return-status
 * @access  Private (Admin)
 */
const overrideReturnStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { returnStatus, notes } = req.body;

    const validStatuses = ['None', 'Requested', 'Approved', 'In Return Transit', 'Returned & Refunded', 'Rejected'];
    if (!validStatuses.includes(returnStatus)) {
      return res.status(400).json({ error: `Invalid returnStatus. Must be one of: ${validStatuses.join(', ')}` });
    }

    const shipment = await Shipment.findOne({
      $or: [
        { shipmentId: id.toUpperCase() },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    const prevReturnStatus = shipment.returnStatus;
    shipment.returnStatus = returnStatus;

    if (returnStatus === 'Approved') {
      shipment.returnApprovedAt = shipment.returnApprovedAt || new Date();
    } else if (returnStatus === 'In Return Transit') {
      shipment.status = 'Return In Transit';
      shipment.escrowStage = -2;
    } else if (returnStatus === 'Returned & Refunded') {
      shipment.status = 'Returned & Refunded';
      shipment.escrowStage = -3;
      // Refund buyer wallet if not already done
      if (shipment.amount > 0 && !shipment.principalRefundedToReceiver) {
        shipment.principalRefundedToReceiver = shipment.amount;
        const receiver = await User.findOne({ phone: shipment.receiverPhone });
        if (receiver) {
          receiver.walletBalance = (receiver.walletBalance || 0) + shipment.amount;
          await receiver.save();
        }
      }
    } else if (returnStatus === 'Rejected') {
      if (shipment.status === 'Return Requested') {
        shipment.status = 'Delivered';
        shipment.escrowStage = 4;
      }
    }

    await shipment.save();

    await logAudit(req, 'OVERRIDE_RETURN_STATUS', 'Shipment', shipment.shipmentId, {
      prevReturnStatus,
      newReturnStatus: returnStatus,
      notes: notes || 'Admin override'
    });

    res.json({
      success: true,
      message: `Return status updated to ${returnStatus}`,
      shipment
    });
  } catch (error) {
    console.error('Admin overrideReturnStatus error:', error);
    res.status(500).json({ error: 'Failed to override return status', details: error.message });
  }
};

/**
 * @desc    Force Approve Return Request
 * @route   POST /api/v1/admin/shipments/:id/return-approve
 * @access  Private (Admin)
 */
const forceApproveReturn = async (req, res) => {
  try {
    const { id } = req.params;
    const { returnAwbCode, returnCarrierSlug, notes } = req.body;

    const shipment = await Shipment.findOne({
      $or: [
        { shipmentId: id.toUpperCase() },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    shipment.returnStatus = returnAwbCode ? 'In Return Transit' : 'Approved';
    shipment.returnApprovedAt = new Date();
    if (returnAwbCode) {
      shipment.returnAwbCode = returnAwbCode;
      shipment.returnCarrierSlug = returnCarrierSlug || 'delhivery';
      shipment.status = 'Return In Transit';
      shipment.escrowStage = -2;
    }

    await shipment.save();

    await logAudit(req, 'FORCE_APPROVE_RETURN', 'Shipment', shipment.shipmentId, {
      returnAwbCode,
      returnCarrierSlug,
      notes: notes || 'Admin force approved return'
    });

    if (shipment.senderId) {
      await createNotification(
        shipment.senderId,
        'Return Request Force Approved',
        `Return request for shipment ${shipment.shipmentId} was approved by administrator.`,
        'alert'
      );
    }

    res.json({
      success: true,
      message: `Return request approved for shipment ${shipment.shipmentId}`,
      shipment
    });
  } catch (error) {
    console.error('Admin forceApproveReturn error:', error);
    res.status(500).json({ error: 'Failed to approve return', details: error.message });
  }
};

/**
 * @desc    Force Reject Return Request
 * @route   POST /api/v1/admin/shipments/:id/return-reject
 * @access  Private (Admin)
 */
const forceRejectReturn = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const shipment = await Shipment.findOne({
      $or: [
        { shipmentId: id.toUpperCase() },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    shipment.returnStatus = 'Rejected';
    shipment.status = 'Delivered';
    shipment.escrowStage = 4;

    await shipment.save();

    await logAudit(req, 'FORCE_REJECT_RETURN', 'Shipment', shipment.shipmentId, {
      reason: reason || 'Rejected by Admin arbitration'
    });

    res.json({
      success: true,
      message: `Return request rejected for shipment ${shipment.shipmentId}`,
      shipment
    });
  } catch (error) {
    console.error('Admin forceRejectReturn error:', error);
    res.status(500).json({ error: 'Failed to reject return', details: error.message });
  }
};

/**
 * @desc    Manually Assign Reverse Logistics AWB Code
 * @route   POST /api/v1/admin/shipments/:id/set-return-awb
 * @access  Private (Admin)
 */
const setReturnAwb = async (req, res) => {
  try {
    const { id } = req.params;
    const { returnAwbCode, returnCarrierSlug, returnCarrierName } = req.body;

    if (!returnAwbCode) {
      return res.status(400).json({ error: 'returnAwbCode is required' });
    }

    const shipment = await Shipment.findOne({
      $or: [
        { shipmentId: id.toUpperCase() },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    shipment.returnAwbCode = String(returnAwbCode).trim();
    if (returnCarrierSlug) shipment.returnCarrierSlug = String(returnCarrierSlug).trim();
    if (returnCarrierName) shipment.returnCarrierName = String(returnCarrierName).trim();
    shipment.returnStatus = 'In Return Transit';
    shipment.status = 'Return In Transit';
    shipment.escrowStage = -2;

    await shipment.save();

    await logAudit(req, 'SET_RETURN_AWB', 'Shipment', shipment.shipmentId, {
      returnAwbCode,
      returnCarrierSlug
    });

    res.json({
      success: true,
      message: `Return AWB ${returnAwbCode} registered successfully`,
      shipment
    });
  } catch (error) {
    console.error('Admin setReturnAwb error:', error);
    res.status(500).json({ error: 'Failed to set return AWB', details: error.message });
  }
};

/**
 * @desc    Manually Assign Replacement Forward AWB Code
 * @route   POST /api/v1/admin/shipments/:id/set-replacement-awb
 * @access  Private (Admin)
 */
const setReplacementAwb = async (req, res) => {
  try {
    const { id } = req.params;
    const { replacementAwbCode, replacementCarrierSlug, replacementCarrierName } = req.body;

    if (!replacementAwbCode) {
      return res.status(400).json({ error: 'replacementAwbCode is required' });
    }

    const shipment = await Shipment.findOne({
      $or: [
        { shipmentId: id.toUpperCase() },
        ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])
      ]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    shipment.replacementAwbCode = String(replacementAwbCode).trim();
    if (replacementCarrierSlug) shipment.replacementCarrierSlug = String(replacementCarrierSlug).trim();
    if (replacementCarrierName) shipment.replacementCarrierName = String(replacementCarrierName).trim();
    shipment.replacementApproved = true;
    shipment.replacementApprovedAt = shipment.replacementApprovedAt || new Date();

    await shipment.save();

    await logAudit(req, 'SET_REPLACEMENT_AWB', 'Shipment', shipment.shipmentId, {
      replacementAwbCode,
      replacementCarrierSlug
    });

    res.json({
      success: true,
      message: `Replacement AWB ${replacementAwbCode} assigned`,
      shipment
    });
  } catch (error) {
    console.error('Admin setReplacementAwb error:', error);
    res.status(500).json({ error: 'Failed to set replacement AWB', details: error.message });
  }
};

/**
 * @desc    Permanently Delete User Account (Super Admin only, protected)
 * @route   DELETE /api/v1/admin/users/:id
 * @access  Private (Super Admin)
 */
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Safety checks
    if (user.email === 'kartickdas6289@gmail.com') {
      return res.status(403).json({ error: 'Primary Super Administrator cannot be deleted' });
    }
    if (user.adminRole === 'super_admin' && req.user.email !== 'kartickdas6289@gmail.com') {
      return res.status(403).json({ error: 'Only Primary Super Admin can delete a Super Admin' });
    }

    const deletedEmail = user.email;
    const deletedRole = user.role;

    await User.findByIdAndDelete(id);

    await logAudit(req, 'DELETE_USER', 'User', id, {
      email: deletedEmail,
      role: deletedRole
    });

    res.json({
      success: true,
      message: `User account ${deletedEmail} has been permanently deleted.`
    });
  } catch (error) {
    console.error('Admin deleteUser error:', error);
    res.status(500).json({ error: 'Failed to delete user', details: error.message });
  }
};

/**
 * @desc    Toggle Phone / Email Verification Status
 * @route   PUT /api/v1/admin/users/:id/verify
 * @access  Private (Admin)
 */
const toggleUserVerification = async (req, res) => {
  try {
    const { id } = req.params;
    const { isPhoneVerified, isEmailVerified } = req.body;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (isPhoneVerified !== undefined) user.isPhoneVerified = Boolean(isPhoneVerified);
    if (isEmailVerified !== undefined) user.isEmailVerified = Boolean(isEmailVerified);

    await user.save();

    await logAudit(req, 'UPDATE_VERIFICATION', 'User', id, {
      isPhoneVerified: user.isPhoneVerified,
      isEmailVerified: user.isEmailVerified
    });

    res.json({
      success: true,
      message: 'Verification status updated',
      user: {
        id: user._id,
        email: user.email,
        isPhoneVerified: user.isPhoneVerified,
        isEmailVerified: user.isEmailVerified
      }
    });
  } catch (error) {
    console.error('Admin toggleUserVerification error:', error);
    res.status(500).json({ error: 'Failed to update verification', details: error.message });
  }
};

/**
 * @desc    Edit User Profile & Bank/UPI Details
 * @route   PUT /api/v1/admin/users/:id/profile
 * @access  Private (Admin)
 */
const updateUserProfileFields = async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, phone, address, city, state, pincode, bankDetails } = req.body;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (fullName) user.fullName = String(fullName).trim();
    if (phone !== undefined) user.phone = phone ? String(phone).trim() : user.phone;
    if (address !== undefined) user.address = String(address).trim();
    if (city !== undefined) user.city = String(city).trim();
    if (state !== undefined) user.state = String(state).trim();
    if (pincode !== undefined) user.pincode = String(pincode).trim();

    if (bankDetails && typeof bankDetails === 'object') {
      user.bankDetails = {
        accountHolderName: bankDetails.accountHolderName ?? user.bankDetails?.accountHolderName ?? '',
        accountNumber: bankDetails.accountNumber ?? user.bankDetails?.accountNumber ?? '',
        ifscCode: bankDetails.ifscCode ?? user.bankDetails?.ifscCode ?? '',
        bankName: bankDetails.bankName ?? user.bankDetails?.bankName ?? '',
        upiId: bankDetails.upiId ?? user.bankDetails?.upiId ?? ''
      };
    }

    await user.save();

    await logAudit(req, 'EDIT_USER_PROFILE', 'User', id, {
      updatedFields: { fullName: user.fullName, phone: user.phone, city: user.city, bankDetails: user.bankDetails }
    });

    res.json({
      success: true,
      message: 'User profile updated successfully',
      user
    });
  } catch (error) {
    console.error('Admin updateUserProfileFields error:', error);
    res.status(500).json({ error: 'Failed to update profile fields', details: error.message });
  }
};

/**
 * @desc    Send Direct Notification to Specific User
 * @route   POST /api/v1/admin/users/:id/notify
 * @access  Private (Admin)
 */
const sendDirectNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, message, type = 'info' } = req.body;

    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await createNotification(user._id, title, message, type);

    await logAudit(req, 'DIRECT_NOTIFICATION', 'User', id, { title, type });

    res.json({
      success: true,
      message: `Notification dispatched to ${user.email}`
    });
  } catch (error) {
    console.error('Admin sendDirectNotification error:', error);
    res.status(500).json({ error: 'Failed to send notification', details: error.message });
  }
};

/**
 * @desc    Adjust User Balances (Wallet, Cashback, Referral Credits)
 * @route   POST /api/v1/admin/users/:id/adjust-balance
 * @access  Private (Admin)
 */
const adjustUserBalances = async (req, res) => {
  try {
    const { id } = req.params;
    const { balanceType = 'wallet', action = 'credit', amount, reason } = req.body;

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Valid positive amount is required' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const fieldMap = {
      wallet: 'walletBalance',
      cashback: 'cashbackBalance',
      referral: 'referralCredits'
    };

    const targetField = fieldMap[balanceType] || 'walletBalance';
    const previousBalance = user[targetField] || 0;

    if (action === 'debit' && previousBalance < numAmount) {
      return res.status(400).json({
        error: `Insufficient balance for debit. Current ${balanceType} balance is ₹${previousBalance}`
      });
    }

    const delta = action === 'credit' ? numAmount : -numAmount;
    user[targetField] = Math.max(0, previousBalance + delta);
    await user.save();

    // Create Reward ledger entry if wallet or cashback adjusted
    if (Reward && (balanceType === 'wallet' || balanceType === 'cashback')) {
      await Reward.create({
        userId: user._id,
        type: action === 'credit' ? 'CASHBACK_EARNED' : 'WITHDRAWAL',
        category: 'PREPAYMENT_REWARD',
        role: user.role || 'User',
        amount: numAmount,
        status: action === 'credit' ? 'CREDITED' : 'WITHDRAWN',
        description: `Admin ${action} of ₹${numAmount} to ${balanceType}. Reason: ${reason || 'Administrative adjustment'}`
      });
    }

    await logAudit(req, 'ADJUST_USER_BALANCE', 'User', id, {
      balanceType,
      action,
      amount: numAmount,
      previousBalance,
      newBalance: user[targetField],
      reason: reason || 'Admin adjustment'
    });

    res.json({
      success: true,
      message: `${balanceType.toUpperCase()} balance ${action}ed by ₹${numAmount}. New balance: ₹${user[targetField]}`,
      user: {
        id: user._id,
        walletBalance: user.walletBalance,
        cashbackBalance: user.cashbackBalance,
        referralCredits: user.referralCredits
      }
    });
  } catch (error) {
    console.error('Admin adjustUserBalances error:', error);
    res.status(500).json({ error: 'Failed to adjust balance', details: error.message });
  }
};

/**
 * @desc    Get User Wallet & Cashback Ledger Transactions
 * @route   GET /api/v1/admin/wallet/transactions/:userId
 * @access  Private (Admin)
 */
const getUserTransactions = async (req, res) => {
  try {
    const { userId } = req.params;
    const rewards = Reward
      ? await Reward.find({ userId }).sort({ createdAt: -1 }).limit(100).lean()
      : [];

    res.json({
      success: true,
      transactions: rewards
    });
  } catch (error) {
    console.error('Admin getUserTransactions error:', error);
    res.status(500).json({ error: 'Failed to retrieve transactions', details: error.message });
  }
};

/**
 * @desc    Get Live Escrow Funds in Custody Breakdown
 * @route   GET /api/v1/admin/finance/escrow-live
 * @access  Private (Admin)
 */
const getLiveEscrowBreakdown = async (req, res) => {
  try {
    const activeShipments = await Shipment.find({
      escrowStage: { $gte: 2, $lt: 6 },
      status: { $nin: ['Cancelled', 'Undelivered', 'Returned & Refunded', 'Released'] }
    })
      .populate('senderId', 'fullName email phone')
      .sort({ createdAt: -1 })
      .lean();

    const totalEscrow = activeShipments.reduce((acc, s) => acc + (s.amount || 0), 0);

    res.json({
      success: true,
      count: activeShipments.length,
      totalEscrowHeld: totalEscrow,
      shipments: activeShipments
    });
  } catch (error) {
    console.error('Admin getLiveEscrowBreakdown error:', error);
    res.status(500).json({ error: 'Failed to retrieve live escrow breakdown', details: error.message });
  }
};

/**
 * @desc    Get Pending Payout / Withdrawal Requests
 * @route   GET /api/v1/admin/finance/withdrawals
 * @access  Private (Admin)
 */
const getWithdrawalRequests = async (req, res) => {
  try {
    if (!Reward) {
      return res.json({ success: true, withdrawals: [] });
    }

    const withdrawals = await Reward.find({
      type: 'WITHDRAWAL'
    })
      .populate('userId', 'fullName email phone bankDetails walletBalance cashbackBalance')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      withdrawals
    });
  } catch (error) {
    console.error('Admin getWithdrawalRequests error:', error);
    res.status(500).json({ error: 'Failed to retrieve withdrawals', details: error.message });
  }
};

/**
 * @desc    Process Payout Request (Approve / Reject)
 * @route   POST /api/v1/admin/finance/withdrawals/:id
 * @access  Private (Admin)
 */
const processWithdrawal = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, transactionRef, reason } = req.body; // 'approve' | 'reject'

    if (!Reward) {
      return res.status(500).json({ error: 'Reward service unavailable' });
    }

    const reward = await Reward.findById(id).populate('userId');
    if (!reward) {
      return res.status(404).json({ error: 'Withdrawal record not found' });
    }

    if (action === 'approve') {
      reward.status = 'WITHDRAWN';
      reward.description = transactionRef ? `Payout completed (Ref: ${transactionRef})` : 'Payout approved by Admin';
      await reward.save();

      await logAudit(req, 'APPROVE_PAYOUT', 'Wallet', id, {
        userId: reward.userId?._id,
        amount: reward.amount,
        transactionRef
      });

      if (reward.userId) {
        await createNotification(
          reward.userId._id,
          'Payout Completed',
          `Your withdrawal of ₹${reward.amount} has been processed successfully. Reference: ${transactionRef || 'Direct Transfer'}`,
          'info'
        );
      }

      return res.json({
        success: true,
        message: `Payout of ₹${reward.amount} marked as completed.`,
        reward
      });
    } else if (action === 'reject') {
      reward.status = 'FAILED';
      reward.description = `Payout rejected: ${reason || 'Bank details invalid'}`;
      await reward.save();

      // Refund money back to user wallet
      if (reward.userId) {
        reward.userId.walletBalance = (reward.userId.walletBalance || 0) + reward.amount;
        await reward.userId.save();

        await createNotification(
          reward.userId._id,
          'Payout Request Rejected',
          `Your withdrawal request of ₹${reward.amount} was rejected. Funds returned to your wallet. Reason: ${reason || 'Details could not be verified'}`,
          'alert'
        );
      }

      await logAudit(req, 'REJECT_PAYOUT', 'Wallet', id, {
        userId: reward.userId?._id,
        amount: reward.amount,
        reason
      });

      return res.json({
        success: true,
        message: `Payout rejected and ₹${reward.amount} refunded to user wallet.`,
        reward
      });
    } else {
      return res.status(400).json({ error: 'Invalid action. Supported: approve, reject' });
    }
  } catch (error) {
    console.error('Admin processWithdrawal error:', error);
    res.status(500).json({ error: 'Failed to process withdrawal', details: error.message });
  }
};

/**
 * @desc    Get Platform Configuration & System Health
 * @route   GET /api/v1/admin/system/config
 * @access  Private (Admin)
 */
const getSystemConfig = async (req, res) => {
  try {
    let config = null;
    if (SystemConfig) {
      config = await SystemConfig.findOne({ configKey: 'GLOBAL_CONFIG' }).lean();
      if (!config) {
        config = await SystemConfig.create({ configKey: 'GLOBAL_CONFIG' });
      }
    } else {
      config = {
        gatewayFeeRate: 0,
        returnWindowHours: 24,
        confirmationWindowHours: 24,
        photoReviewFee: 2,
        undeliveredPenaltyReceiver: 40,
        undeliveredReliefSupplier: 20,
        mockCarrierEnabled: true
      };
    }

    const health = {
      uptimeSeconds: process.uptime(),
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      nodeVersion: process.version,
      databaseStatus: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected',
      timestamp: new Date()
    };

    res.json({
      success: true,
      config,
      health
    });
  } catch (error) {
    console.error('Admin getSystemConfig error:', error);
    res.status(500).json({ error: 'Failed to retrieve system configuration', details: error.message });
  }
};

/**
 * @desc    Update Platform Configuration
 * @route   PUT /api/v1/admin/system/config
 * @access  Private (Super Admin / Operations Admin)
 */
const updateSystemConfig = async (req, res) => {
  try {
    const {
      gatewayFeeRate,
      returnWindowHours,
      confirmationWindowHours,
      photoReviewFee,
      undeliveredPenaltyReceiver,
      undeliveredReliefSupplier,
      mockCarrierEnabled,
      maintenanceMode
    } = req.body;

    let config = await SystemConfig.findOne({ configKey: 'GLOBAL_CONFIG' });
    if (!config) {
      config = new SystemConfig({ configKey: 'GLOBAL_CONFIG' });
    }

    if (gatewayFeeRate !== undefined) config.gatewayFeeRate = Number(gatewayFeeRate);
    if (returnWindowHours !== undefined) config.returnWindowHours = Number(returnWindowHours);
    if (confirmationWindowHours !== undefined) config.confirmationWindowHours = Number(confirmationWindowHours);
    if (photoReviewFee !== undefined) config.photoReviewFee = Number(photoReviewFee);
    if (undeliveredPenaltyReceiver !== undefined) config.undeliveredPenaltyReceiver = Number(undeliveredPenaltyReceiver);
    if (undeliveredReliefSupplier !== undefined) config.undeliveredReliefSupplier = Number(undeliveredReliefSupplier);
    if (mockCarrierEnabled !== undefined) config.mockCarrierEnabled = Boolean(mockCarrierEnabled);
    if (maintenanceMode !== undefined) config.maintenanceMode = Boolean(maintenanceMode);

    config.updatedBy = req.user?.email || 'admin';
    config.updatedAt = new Date();

    await config.save();

    await logAudit(req, 'UPDATE_SYSTEM_CONFIG', 'System', 'GLOBAL_CONFIG', {
      gatewayFeeRate: config.gatewayFeeRate,
      returnWindowHours: config.returnWindowHours,
      confirmationWindowHours: config.confirmationWindowHours,
      mockCarrierEnabled: config.mockCarrierEnabled
    });

    res.json({
      success: true,
      message: 'System configuration updated successfully',
      config
    });
  } catch (error) {
    console.error('Admin updateSystemConfig error:', error);
    res.status(500).json({ error: 'Failed to update system configuration', details: error.message });
  }
};

/**
 * @desc    Get Bulk Excel Booking Jobs Queue
 * @route   GET /api/v1/admin/system/bulk-jobs
 * @access  Private (Admin)
 */
const getBulkJobs = async (req, res) => {
  try {
    if (!BulkJob) {
      return res.json({ success: true, jobs: [] });
    }

    const jobs = await BulkJob.find({})
      .populate('userId', 'fullName email phone')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({
      success: true,
      count: jobs.length,
      jobs
    });
  } catch (error) {
    console.error('Admin getBulkJobs error:', error);
    res.status(500).json({ error: 'Failed to retrieve bulk jobs', details: error.message });
  }
};

/**
 * @desc    Export Platform Data (Shipments, Users, Disputes, Returns, Finance) in JSON or CSV
 * @route   GET /api/v1/admin/export/:type
 * @access  Private (Admin)
 */
const exportData = async (req, res) => {
  try {
    const { type } = req.params;
    const { format } = req.query; // 'csv' or 'json'

    if (type === 'shipments') {
      const shipments = await Shipment.find({})
        .populate('senderId', 'fullName email phone')
        .sort({ createdAt: -1 })
        .lean();

      if (format === 'csv') {
        const fields = [
          { label: 'Shipment ID', key: 'shipmentId' },
          { label: 'Created At', key: 'createdAt' },
          { label: 'Status', key: 'status' },
          { label: 'Amount (INR)', key: 'amount' },
          { label: 'Payment Mode', key: 'paymentMode' },
          { label: 'Escrow Stage', key: 'escrowStage' },
          { label: 'Carrier', key: 'carrierSlug' },
          { label: 'AWB', key: 'awbCode' },
          { label: 'Sender Name', getter: s => s.senderId?.fullName || '' },
          { label: 'Sender Email', getter: s => s.senderId?.email || '' },
          { label: 'Sender Phone', getter: s => s.senderId?.phone || '' },
          { label: 'Receiver Name', key: 'receiverName' },
          { label: 'Receiver Phone', key: 'receiverPhone' },
          { label: 'Route City', key: 'city' },
          { label: 'Return Status', key: 'returnStatus' },
          { label: 'Return AWB', key: 'returnAwbCode' }
        ];

        const csv = convertToCSV(shipments, fields);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="shipments_export_${Date.now()}.csv"`);
        return res.send(csv);
      }

      return res.json({
        success: true,
        type: 'shipments',
        exportedAt: new Date(),
        count: shipments.length,
        data: shipments
      });
    } else if (type === 'users') {
      const users = await User.find({}).select('-passwordHash').sort({ createdAt: -1 }).lean();

      if (format === 'csv') {
        const fields = [
          { label: 'User ID', getter: u => String(u._id) },
          { label: 'Full Name', key: 'fullName' },
          { label: 'Email', key: 'email' },
          { label: 'Phone', key: 'phone' },
          { label: 'Role', key: 'role' },
          { label: 'Admin Role', key: 'adminRole' },
          { label: 'Suspended', getter: u => u.isSuspended ? 'Yes' : 'No' },
          { label: 'Pro Plan', getter: u => u.isPro ? 'Pro' : 'Standard' },
          { label: 'Wallet Balance (INR)', key: 'walletBalance' },
          { label: 'Cashback Balance (INR)', key: 'cashbackBalance' },
          { label: 'Referral Credits', key: 'referralCredits' },
          { label: 'Referral Code', key: 'referralCode' },
          { label: 'City', key: 'city' },
          { label: 'Created At', key: 'createdAt' }
        ];

        const csv = convertToCSV(users, fields);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="users_export_${Date.now()}.csv"`);
        return res.send(csv);
      }

      return res.json({
        success: true,
        type: 'users',
        exportedAt: new Date(),
        count: users.length,
        data: users
      });
    } else if (type === 'disputes') {
      const claims = await Claim.find({}).populate('filedBy', 'fullName email phone').sort({ createdAt: -1 }).lean();

      if (format === 'csv') {
        const fields = [
          { label: 'Claim ID', getter: c => String(c._id) },
          { label: 'Shipment ID', key: 'shipmentId' },
          { label: 'Filed By', getter: c => c.filedBy?.fullName || '' },
          { label: 'Email', getter: c => c.filedBy?.email || '' },
          { label: 'Status', key: 'status' },
          { label: 'Reason', key: 'reason' },
          { label: 'Description', key: 'description' },
          { label: 'Created At', key: 'createdAt' }
        ];

        const csv = convertToCSV(claims, fields);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="disputes_export_${Date.now()}.csv"`);
        return res.send(csv);
      }

      return res.json({
        success: true,
        type: 'disputes',
        exportedAt: new Date(),
        count: claims.length,
        data: claims
      });
    } else if (type === 'returns') {
      const returns = await Shipment.find({
        $or: [
          { returnStatus: { $ne: 'None' } },
          { status: { $in: ['Return Requested', 'Return In Transit', 'Returned & Refunded'] } }
        ]
      })
        .populate('senderId', 'fullName email phone')
        .sort({ returnRequestedAt: -1 })
        .lean();

      if (format === 'csv') {
        const fields = [
          { label: 'Shipment ID', key: 'shipmentId' },
          { label: 'Return Status', key: 'returnStatus' },
          { label: 'Return Type', key: 'returnType' },
          { label: 'Return AWB', key: 'returnAwbCode' },
          { label: 'Return Carrier', key: 'returnCarrierSlug' },
          { label: 'Replacement AWB', key: 'replacementAwbCode' },
          { label: 'Return Reason', key: 'returnReason' },
          { label: 'Amount (INR)', key: 'amount' },
          { label: 'Supplier Name', getter: s => s.senderId?.fullName || '' },
          { label: 'Receiver Name', key: 'receiverName' },
          { label: 'Receiver Phone', key: 'receiverPhone' }
        ];

        const csv = convertToCSV(returns, fields);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="returns_export_${Date.now()}.csv"`);
        return res.send(csv);
      }

      return res.json({
        success: true,
        type: 'returns',
        exportedAt: new Date(),
        count: returns.length,
        data: returns
      });
    } else if (type === 'finance') {
      const rewards = Reward
        ? await Reward.find({}).populate('userId', 'fullName email phone').sort({ createdAt: -1 }).lean()
        : [];

      if (format === 'csv') {
        const fields = [
          { label: 'Transaction ID', getter: r => String(r._id) },
          { label: 'Date', key: 'createdAt' },
          { label: 'User Name', getter: r => r.userId?.fullName || '' },
          { label: 'User Email', getter: r => r.userId?.email || '' },
          { label: 'Type', key: 'type' },
          { label: 'Category', key: 'category' },
          { label: 'Amount (INR)', key: 'amount' },
          { label: 'Status', key: 'status' },
          { label: 'Description', key: 'description' }
        ];

        const csv = convertToCSV(rewards, fields);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="finance_export_${Date.now()}.csv"`);
        return res.send(csv);
      }

      return res.json({
        success: true,
        type: 'finance',
        exportedAt: new Date(),
        count: rewards.length,
        data: rewards
      });
    } else {
      res.status(400).json({ error: 'Invalid export type. Supported: shipments, users, disputes, returns, finance' });
    }
  } catch (error) {
    console.error('Admin Export Error:', error);
    res.status(500).json({ error: 'Failed to export data', details: error.message });
  }
};

module.exports = {
  getAnalyticsDashboard,
  getAllUsers,
  getUserById,
  suspendUser,
  unsuspendUser,
  updateUserRole,
  deleteUser,
  toggleUserVerification,
  updateUserProfileFields,
  sendDirectNotification,
  adjustUserBalances,
  getUserTransactions,
  getAllShipments,
  getSingleShipment,
  cancelShipmentAdmin,
  confirmDeliveryManually,
  toggleShipmentLock,
  editShipmentDetails,
  manageInboxQr,
  getAllReturns,
  overrideReturnStatus,
  forceApproveReturn,
  forceRejectReturn,
  setReturnAwb,
  setReplacementAwb,
  overrideShipmentStatus,
  forceReleaseEscrow,
  forceRefundEscrow,
  getAllDisputes,
  resolveDispute,
  getFinancialSummary,
  getLiveEscrowBreakdown,
  getWithdrawalRequests,
  processWithdrawal,
  adjustWalletBalance,
  getSystemConfig,
  updateSystemConfig,
  getBulkJobs,
  broadcastNotification,
  getAuditLogs,
  exportData
};
