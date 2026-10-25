const mongoose = require('mongoose');

const ShipmentSchema = new mongoose.Schema({
  shipmentId: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true,
    trim: true
  }, // Format: SPL-XXXX-X
  senderId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  receiverName: { 
    type: String, 
    required: true,
    trim: true
  },
  receiverPhone: { 
    type: String, 
    required: true,
    trim: true
  },
  receiverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  description: { 
    type: String, 
    required: true 
  },
  amount: { 
    type: Number, 
    required: true 
  }, // In INR (₹)
  city: { 
    type: String, 
    default: "" 
  }, // Route description (e.g., "Mumbai -> Delhi")
  
  // Logistics Integration Fields (TrackCourier)
  carrierSlug: { 
    type: String, 
    default: "" 
  },
  awbCode: { 
    type: String, 
    default: "" 
  },
  shippingLabelUrl: { 
    type: String, 
    default: "" 
  },
  
  // Cashfree Payment Link & Payout Fields
  paymentLink: {
    type: String,
    default: ""
  },
  cashfreeLinkId: {
    type: String,
    default: ""
  },

  // YouPI-PG UPI Gateway Integration Fields
  paymentMode: {
    type: String,
    enum: ['cod', 'prepaid_youpi', 'prepaid_cashfree', 'escrow', ''],
    default: ''
  },
  youpiPaymentId: {
    type: String,
    default: null
  },
  youpiPaymentConfirmed: {
    type: Boolean,
    default: false
  },
  youpiConfirmedAt: {
    type: Date,
    default: null
  },
  payoutTransferMode: {
    type: String,
    enum: ['IMPS', 'UPI', 'NEFT', 'RTGS', ''],
    default: ''
  },
  payoutTransferId: {
    type: String,
    default: ""
  },
  payoutStatus: {
    type: String,
    default: ""
  },

  // Reverse Logistics & Return Integration Fields
  returnStatus: {
    type: String,
    enum: ['None', 'Requested', 'Approved', 'In Return Transit', 'Returned & Refunded', 'Rejected', 'Completed'],
    default: 'None'
  },
  returnAwbCode: {
    type: String,
    default: ""
  },
  returnCarrierSlug: {
    type: String,
    default: ""
  },
  returnCarrierName: {
    type: String,
    default: ""
  },
  returnReason: {
    type: String,
    default: ""
  },
  returnRequestedAt: {
    type: Date
  },
  returnApprovedAt: {
    type: Date
  },
  returnReversePickupScheduledAt: {
    type: Date
  },
  returnPickupWindow: {
    type: String,
    default: ""
  },
  returnShippingRate: {
    type: Number,
    default: 0
  },
  returnEstimatedSavings: {
    type: Number,
    default: 0
  },
  returnAutoBooked: {
    type: Boolean,
    default: false
  },
  returnCarrierComparison: {
    type: Array,
    default: []
  },
  returnReverseCourierDetailsAddedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  returnShippingLabelUrl: {
    type: String,
    default: ""
  },
  returnSmsNotification: {
    type: String,
    default: ""
  },

  // Reverse Shipping Fee Accounting (Seller Pays Policy)
  returnShippingChargeDeducted: {
    type: Number,
    default: 0
  },
  returnShippingChargePaidBy: {
    type: String,
    enum: ['seller', 'buyer', 'platform', 'none'],
    default: 'seller'
  },
  returnShippingChargeStatus: {
    type: String,
    enum: ['Pending', 'Deducted', 'Waived', 'Settled'],
    default: 'Pending'
  },
  returnShippingChargeDeductedFrom: {
    type: String,
    default: 'seller_wallet'
  },
  returnShippingChargeDeductedAt: {
    type: Date
  },

  // Seller Return Configuration & Policy
  returnAllowed: {
    type: Boolean,
    default: true
  },
  returnOptionEnabledAt: {
    type: Date
  },
  paymentLinkSmsText: {
    type: String,
    default: ""
  },

  // ── 3-Option Return System ─────────────────────────────────────────────────
  // Which return path the buyer chose
  returnType: {
    type: String,
    enum: ['full_refund', 'replacement', 'partial_discount'],
    default: 'full_refund'
  },

  // Option 2: Partial Discount — buyer defect evidence
  defectPhotoUrl: { type: String, default: '' },
  defectDescription: { type: String, default: '' },

  // Bank / UPI details for full_refund payouts
  returnBankDetails: {
    accountHolderName: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    ifscCode: { type: String, default: '' },
    bankName: { type: String, default: '' },
    upiId: { type: String, default: '' }
  },

  // Option 2: Partial Discount — supplier offer & buyer response
  discountOfferedAmount: { type: Number, default: 0 },
  discountOfferedAt: { type: Date },
  discountAccepted: { type: Boolean, default: null },   // null = pending
  discountAcceptedAt: { type: Date },
  discountBuyerWalletCredited: { type: Number, default: 0 },
  discountSupplierWalletCredited: { type: Number, default: 0 },
  partialRefundAmount: { type: Number, default: 0 },
  partialRefundStatus: { type: String, enum: ['None', 'Offered', 'Approved', 'Refunded', 'Rejected'], default: 'None' },
  partialRefundAt: { type: Date },
  partialRefundBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  discountAutoCompletedBySupplier: { type: Boolean, default: false },

  // Option 1: Replacement — supplier approval
  replacementApproved: { type: Boolean, default: null }, // null = pending
  replacementApprovedAt: { type: Date },
  replacementRejectedAt: { type: Date },
  replacementCarrierSlug: { type: String, default: '' },
  replacementCarrierName: { type: String, default: '' },
  replacementAwbCode: { type: String, default: '' },   // Forward leg: Supplier → Buyer (new item)

  // Option 1: Replacement — reverse pickup leg (old/defective product: Buyer → Supplier)
  replacementPickupCarrierSlug: { type: String, default: '' },
  replacementPickupCarrierName: { type: String, default: '' },
  replacementPickupAwbCode: { type: String, default: '' },   // REV- prefixed AWB
  replacementPickupWindow: { type: String, default: '' },     // e.g. "Tomorrow, 10:00 AM – 2:00 PM"
  replacementPickupScheduledAt: { type: Date },
  replacementPickupRate: { type: Number, default: 0 },
  replacementPickupBookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },


  // Option 1: Replacement — 4-step workflow tracking
  oldItemReceivedBySupplier: { type: Boolean, default: false },
  oldItemReceivedAt: { type: Date },
  replacementItemDispatched: { type: Boolean, default: false },
  replacementItemDispatchedAt: { type: Date },
  replacementDelivered: { type: Boolean, default: false },
  replacementDeliveredAt: { type: Date },

  // Replacement In-Box QR & SMS OTP Verification
  replacementQrToken: { type: String, default: '' },
  replacementQrGeneratedAt: { type: Date },
  replacementQrUsed: { type: Boolean, default: false },
  replacementQrConfirmedAt: { type: Date },
  replacementDeliveryOtp: { type: String, default: '' },
  replacementDeliveryOtpExpiresAt: { type: Date },
  replacementDeliveryOtpUsed: { type: Boolean, default: false },
  replacementDispatchedOnPickupScan: { type: Boolean, default: false },

  // Payment Mode: how the buyer pays for the shipment
  paymentMode: {
    type: String,
    enum: ['prepaid', 'cod', 'paid_offline'],
    default: 'prepaid'
  },
  // For prepaid: whether the payment was received before dispatch
  isPrepaid: {
    type: Boolean,
    default: false
  },

  // COD specific fees & supplier upfront settlement
  codCharge: {
    type: Number,
    default: 0
  },
  deliveryCharge: {
    type: Number,
    default: 0
  },
  codUpfrontFee: {
    type: Number,
    default: 0
  },
  codFeePaid: {
    type: Boolean,
    default: false
  },
  codFeePaymentMethod: {
    type: String,
    enum: ['none', 'wallet_adjustment', 'online_gateway', 'paid_offline'],
    default: 'none'
  },
  codFeePaidAt: {
    type: Date
  },
  codFeeTransactionRef: {
    type: String,
    default: ''
  },

  // Parcel Photo Verification Feature (Mandatory for all shipments at ₹0 fee)
  photoReviewEnabled: {
    type: Boolean,
    default: true
  },
  photoReviewFee: {
    type: Number,
    default: 0
  },
  photoReviewRequested: {
    type: Boolean,
    default: true
  },
  photoReviewPaid: {
    type: Boolean,
    default: true
  },
  photoReviewRefused: {
    type: Boolean,
    default: false
  },
  parcelPhotoUrl: {         // Uploaded by supplier before dispatch
    type: String,
    default: ''
  },
  parcelPhotoUploadedAt: {
    type: Date
  },

  status: { 
    type: String, 
    enum: [
      'Awaiting Payment', 
      'Pending Pickup', 
      'In Transit', 
      'Reached Destination Hub', 
      'Out for Delivery', 
      'Delivered', 
      'Released', 
      'Locked',
      'Cancelled',
      'Undelivered',
      'Return Requested',
      'Return In Transit',
      'Returned & Refunded',
      'Replacement In Transit'
    ], 
    default: 'Awaiting Payment' 
  },
  escrowStage: { 
    type: Number, 
    enum: [1, 2, 3, 4, 5, 6, -1, -2, -3, -4, -5], 
    default: 1 
  },
  
  // Escrow Financial Settlement Ledger Fields
  escrowInterestRate: { 
    type: Number, 
    default: 0 
  },
  daysInEscrow: { 
    type: Number, 
    default: 0 
  },
  accruedInterest: { 
    type: Number, 
    default: 0 
  },
  receiverInterestPaid: { 
    type: Number, 
    default: 0 
  },
  supplierInterestPaid: { 
    type: Number, 
    default: 0 
  },
  supplierCashbackPaid: { 
    type: Number, 
    default: 0 
  },
  principalDisbursedToSupplier: { 
    type: Number, 
    default: 0 
  },
  gatewayFeeDeducted: {
    type: Number,
    default: 0
  },
  gatewayFeeRate: {
    type: Number,
    default: 0
  },
  serviceFeeDeducted: {
    type: Number,
    default: 0
  },
  serviceFeeRate: {
    type: Number,
    default: 0.016
  },
  isOverMonthlyThreshold: {
    type: Boolean,
    default: false
  },
  principalRefundedToReceiver: { 
    type: Number, 
    default: 0 
  },

  // Courier Delivery Charge & Settlement Ledger Fields
  courierDeliveryCharge: {
    type: Number,
    default: 0
  },
  codHandlingCharge: {
    type: Number,
    default: 0
  },
  courierChargeDeducted: {
    type: Number,
    default: 0
  },
  courierChargeDeductedFrom: {
    type: String,
    enum: ['escrow_settlement', 'seller_wallet', 'cod_remittance', 'pending_recovery', 'none'],
    default: 'none'
  },
  courierChargeStatus: {
    type: String,
    enum: ['Pending', 'Deducted', 'Waived', 'Refunded'],
    default: 'Pending'
  },
  netSellerPayout: {
    type: Number,
    default: 0
  },

  // ── In-Box QR Code Delivery Sign-Off System ───────────────────────────────
  // A unique token placed inside the parcel (as a printable QR) by the seller.
  // Receiver scans QR or enters OTP to confirm delivery without logging in.
  inboxQrToken: {
    type: String,
    default: ''
  },
  inboxQrGeneratedAt: {
    type: Date
  },
  inboxQrUsed: {
    type: Boolean,
    default: false
  },
  inboxQrConfirmedAt: {
    type: Date
  },
  inboxQrConfirmMethod: {
    type: String,
    enum: ['qr_scan', 'otp', 'manual', 'qr_scan_return'],
    default: 'manual'
  },
  deliveryOtp: {
    type: String,
    default: ''
  },
  deliveryOtpExpiresAt: {
    type: Date
  },
  deliveryOtpUsed: {
    type: Boolean,
    default: false
  },

  // Smart RTO & Undelivered Protection
  rtoProtectionEnabled: {
    type: Boolean,
    default: false
  },
  undeliveredSupplierRelief: {
    type: Number,
    default: 0 // ₹20 relief given to supplier by SecureKaro
  },
  undeliveredSupplierPenalty: {
    type: Number,
    default: 0 // Always 0 — SecureKaro never penalizes sellers for undelivered shipments
  },
  undeliveredReceiverPenalty: {
    type: Number,
    default: 0 // ₹40 penalty charged if receiver > 1 undelivered in a week
  },
  undeliveredSupplierCharge: {
    type: Number,
    default: 0
  },
  undeliveredPlatformCharge: {
    type: Number,
    default: 0
  },
  undeliveredReason: {
    type: String,
    default: ''
  },
  undeliveredProcessedAt: {
    type: Date
  },

  // 24-Hour Confirmation Window & Supplier Wallet Tracking
  trackingSubmitted: {
    type: Boolean,
    default: false
  },
  trackingSubmittedAt: {
    type: Date
  },
  receiverPaymentDone: {
    type: Boolean,
    default: false
  },
  receiverPaidAt: {
    type: Date
  },
  confirmationWindowExpiresAt: {
    type: Date
  },
  confirmationWindowClosed: {
    type: Boolean,
    default: false
  },
  withdrawableAt: {
    type: Date
  },
  supplierCashbackAmount: {
    type: Number,
    default: 0
  },
  receiverCashbackAmount: {
    type: Number,
    default: 0
  },

  // Receiver Parcel Delivery Confirmation & 24-Hour Return Window
  deliveryConfirmed: {
    type: Boolean,
    default: false
  },
  deliveryConfirmedAt: {
    type: Date
  },
  returnWindowExpiresAt: {
    type: Date
  },
  returnWindowClosed: {
    type: Boolean,
    default: false
  },
  returnWindowChoice: {
    type: String,
    enum: ['ImmediateClose', 'KeepOpen24h', 'None'],
    default: 'None'
  },
  returnClosedAt: {
    type: Date
  },

  // ── AI Agent Booking Fields ───────────────────────────────────────────────
  bookedViaAgent: {
    type: Boolean,
    default: false
  },
  agentSessionId: {
    type: String,
    default: ''
  },
  receiverAddress: {
    type: String,
    default: ''
  },
  receiverPincode: {
    type: String,
    default: ''
  },
  senderAddress: {
    type: String,
    default: ''
  },
  senderPincode: {
    type: String,
    default: ''
  },
  parcelWeight: {
    type: Number,
    default: 0
  },
  parcelLength: {
    type: Number,
    default: 0
  },
  parcelWidth: {
    type: Number,
    default: 0
  },
  parcelHeight: {
    type: Number,
    default: 0
  },
  autoCarrierSelected: {
    type: Boolean,
    default: false
  },
  pickupScheduledAt: {
    type: Date
  },
  pickupToken: {
    type: String,
    default: ''
  },
  pickupSlot: {
    type: String,
    default: ''
  },
  pickupStatus: {
    type: String,
    enum: ['None', 'Scheduled', 'Out for Pickup', 'Picked Up', 'Completed', 'Cancelled', 'Rescheduled'],
    default: 'None'
  },
  pickupCarrier: {
    type: String,
    default: ''
  },
  pickupCarrierSlug: {
    type: String,
    default: ''
  },
  pickupRate: {
    type: Number,
    default: 0
  },
  pickupExpectedDate: {
    type: Date
  },
  pickupAgentName: {
    type: String,
    default: ''
  },
  pickupAgentPhone: {
    type: String,
    default: ''
  },
  pickupLocationAddress: {
    type: String,
    default: ''
  },
  pickupRateComparison: {
    type: Array,
    default: []
  },
  pickupAggregator: {
    type: String,
    default: 'Shiprocket'
  },
  shiprocketOrderId: {
    type: Number,
    default: null
  },
  shiprocketShipmentId: {
    type: Number,
    default: null
  },
  nimbusOrderId: {
    type: String,
    default: null
  },
  nimbusShipmentId: {
    type: String,
    default: null
  },
  bulkJobId: {
    type: String,
    default: ''
  },

  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Update timestamps before saving
ShipmentSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

// ── Performance & Query Indexes ─────────────────────────────────────────────
//
// COMPOSITE — Seller shipment list (most frequent API call).
// Covers: Shipment.find({ senderId: { $in: ids } }).sort({ createdAt: -1 })
// Eliminates the SORT stage; also satisfies queries on senderId alone via prefix.
ShipmentSchema.index({ senderId: 1, createdAt: -1 });

// COMPOSITE — Seller-scoped confirmation window check.
// Covers: Shipment.find({ senderId, confirmationWindowClosed })
ShipmentSchema.index({ senderId: 1, confirmationWindowClosed: 1 });

// COMPOSITE — Seller-scoped return orders list.
// Covers: Shipment.find({ senderId: { $in: ids }, returnStatus: { $in: [...] } })
ShipmentSchema.index({ senderId: 1, returnStatus: 1 });

// SINGLE — Receiver phone lookup (receiver shipment list, $or queries).
ShipmentSchema.index({ receiverPhone: 1 });

// SINGLE — Status + date sort for admin dashboard and cron status filters.
// Covers: Shipment.find({ status }).sort({ createdAt: -1 })
// Also satisfies single-field { status: 1 } queries via prefix.
ShipmentSchema.index({ status: 1, createdAt: -1 });

// SINGLE — Bare createdAt sort index (admin full list, no status filter).
ShipmentSchema.index({ createdAt: -1 });

// SPARSE — AWB code lookup for tracking webhooks and public tracking.
// Covers: Shipment.findOne({ awbCode }), $or queries mixing awbCode+shipmentId.
// Sparse: many shipments start with empty awbCode; sparse skips them.
ShipmentSchema.index({ awbCode: 1 }, { sparse: true });

// SPARSE — InboxQrToken for QR-scan and OTP delivery confirmation.
// Covers: Shipment.findOne({ inboxQrToken: token })
ShipmentSchema.index({ inboxQrToken: 1 }, { sparse: true });

// SPARSE — YouPI payment ID for payment gateway webhooks.
// Covers: Shipment.findOne({ youpiPaymentId })
ShipmentSchema.index({ youpiPaymentId: 1 }, { sparse: true });

// COMPOSITE — Background tracking poll (runs every 30 minutes).
// Covers: Shipment.find({ escrowStage: 4, awbCode: { $ne: "" } })
// Eliminates full collection scan every 30 minutes.
ShipmentSchema.index({ escrowStage: 1, awbCode: 1 });

// COMPOSITE — Return window auto-close cron (runs every 15 minutes).
// Covers: Shipment.find({ deliveryConfirmed, returnWindowClosed, returnWindowExpiresAt: { $lte } })
// Supersedes the old 2-field { returnWindowClosed, returnWindowExpiresAt } index.
ShipmentSchema.index({ deliveryConfirmed: 1, returnWindowClosed: 1, returnWindowExpiresAt: 1 });

// SINGLE — Return AWB for reverse logistics lookups.
ShipmentSchema.index({ returnAwbCode: 1 });

// ── Redundant Indexes (commented out — kept for reference / rollback) ─────────
// { senderId: 1 }          — superseded by { senderId: 1, createdAt: -1 } (prefix)
// { returnWindowClosed: 1, returnWindowExpiresAt: 1 } — superseded by 3-field composite above
// { returnAllowed: 1 }     — boolean, low cardinality, not a useful standalone index
// { returnCarrierSlug: 1 } — very low query frequency, not worth the write overhead

module.exports = mongoose.model('Shipment', ShipmentSchema);
