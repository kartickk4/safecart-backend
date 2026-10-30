const Shipment = require('../models/Shipment');
const CarrierJourney = require('../models/CarrierJourney');
const User = require('../models/User');
const carrierTracking = require('../services/carrierTracking');
const escrow = require('../services/escrow');
const cashfreeService = require('../services/cashfreeService');
const { createNotification } = require('../services/notification');
const { grantDeliveryConfirmCashback, grantPrepaymentCashback } = require('../services/rewardService');
const smsService = require('../services/smsService');
const whatsappService = require('../services/whatsappService');
const { getCarrierRates, getCarrierRatesAsync } = require('../services/carrierRateService');
const { autoScheduleCourierPickup } = require('../services/pickupService');
const { calculateServiceFee, calculateSellerPayout } = require('../utils/feeConfig');
const crypto = require('crypto');
const { cacheManager } = require('../services/cacheManager');

// Helper to invalidate admin dashboard aggregates whenever shipment state changes
const invalidateDashboardCache = () => {
  cacheManager.invalidateTag('admin:analytics').catch(() => {});
  cacheManager.invalidateTag('admin:finance').catch(() => {});
  cacheManager.invalidatePattern('admin:*').catch(() => {});
};

/**
 * Helper: Generate Shipment ID in form SPL-XXXX-X
 */
const generateShipmentId = () => {
  const num = Math.floor(1000 + Math.random() * 9000);
  const char = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `SPL-${num}-${char}`;
};

/**
 * Helper: Find all user IDs linked to the current user (same _id, email, or phone)
 * Supports seamless switching between Receiver and Supplier accounts.
 */
const getLinkedUserIds = async (user) => {
  if (!user) return [];
  const filters = [{ _id: user._id }];
  if (user.email && user.email.trim()) {
    filters.push({ email: user.email.toLowerCase().trim() });
  }
  if (user.phone && user.phone.trim()) {
    const raw = user.phone.trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 10) {
      const ten = digits.slice(-10);
      filters.push({ phone: { $in: [ten, `+91${ten}`, `91${ten}`, `+91 ${ten}`, raw] } });
    } else {
      filters.push({ phone: raw });
    }
  }
  const linked = await User.find({ $or: filters }, '_id').lean();
  return linked.map(u => u._id);
};

/**
 * Helper: Check if user is the sender/supplier of this shipment or admin
 * Allows users who switch roles under the same email/phone to manage their shipments.
 */
const isAuthorizedSenderOrSupplier = async (user, shipment) => {
  if (!user || !shipment) return false;
  if (user.role === 'Admin') return true;
  if (shipment.senderId && shipment.senderId.toString() === user._id.toString()) return true;

  if (shipment.senderId) {
    const linkedIds = await getLinkedUserIds(user);
    if (linkedIds.some(id => id.toString() === shipment.senderId.toString())) {
      return true;
    }
  }
  return false;
};

/**
 * Helper: Check if user is the receiver of this shipment
 * Normalizes phone numbers to tolerate differing country code formats (+91, spaces, 10-digit).
 */
const isAuthorizedReceiver = (user, shipment) => {
  if (!user || !shipment) return false;
  if (user.role === 'Admin') return true;
  if (shipment.receiverId && (String(shipment.receiverId) === String(user._id) || (shipment.receiverId._id && String(shipment.receiverId._id) === String(user._id)))) return true;
  if (!shipment.receiverPhone) return false;
  if (shipment.receiverPhone === user.phone) return true;
  const userDigits = (user.phone || '').replace(/\D/g, '').slice(-10);
  const recvDigits = (shipment.receiverPhone || '').replace(/\D/g, '').slice(-10);
  return Boolean(userDigits && recvDigits && userDigits === recvDigits);
};

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
 * @desc    List shipments involving current user
 * @route   GET /api/v1/shipments
 * @access  Private
 */
const getShipments = async (req, res) => {
  try {
    const userPhone = req.user.phone;
    const userIds = await getLinkedUserIds(req.user);
    const role = (req.query.role || '').toLowerCase(); // 'supplier' | 'receiver' | ''

    let query = {};

    if (role === 'supplier') {
      // Only shipments this user created as a sender (Indexed on senderId)
      query = { senderId: { $in: userIds } };
    } else if (role === 'receiver') {
      // Only shipments where this user is the receiver
      const receiverPhones = [];
      if (userPhone && userPhone.trim()) {
        const raw = userPhone.trim();
        const digits = raw.replace(/\D/g, '');
        receiverPhones.push(raw);
        if (digits.length >= 10) {
          const ten = digits.slice(-10);
          receiverPhones.push(ten, `+91${ten}`, `91${ten}`, `+91 ${ten}`);
        }
      }
      if (receiverPhones.length === 0) {
        return res.json([]);
      }
      query = {
        $and: [
          { receiverPhone: { $in: receiverPhones } },
          { senderId: { $nin: userIds } }
        ]
      };
    } else {
      // No role filter — return all (sender OR receiver)
      const queryConditions = [{ senderId: { $in: userIds } }];
      if (userPhone && userPhone.trim()) {
        const raw = userPhone.trim();
        const digits = raw.replace(/\D/g, '');
        const receiverPhones = [raw];
        if (digits.length >= 10) {
          const ten = digits.slice(-10);
          receiverPhones.push(ten, `+91${ten}`, `91${ten}`, `+91 ${ten}`);
        }
        queryConditions.push({ receiverPhone: { $in: receiverPhones } });
      }
      query = { $or: queryConditions };
    }

    // Server-Side High-Efficiency Pagination
    const totalCount = await Shipment.countDocuments(query);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = req.query.limit 
      ? Math.min(100, Math.max(1, parseInt(req.query.limit, 10))) 
      : (req.query.page ? 20 : 0);

    let shipmentQuery = Shipment.find(query)
      .select('-parcelPhoto -defectPhoto')
      .sort({ createdAt: -1 });

    if (limit > 0) {
      const skip = (page - 1) * limit;
      shipmentQuery = shipmentQuery.skip(skip).limit(limit);
    }

    const shipments = await shipmentQuery.lean();

    const totalPages = limit > 0 ? Math.ceil(totalCount / limit) : 1;
    res.setHeader('X-Total-Count', String(totalCount));
    res.setHeader('X-Total-Pages', String(totalPages));
    res.setHeader('X-Current-Page', String(page));
    res.setHeader('X-Per-Page', String(limit || totalCount));

    res.json(shipments);
  } catch (error) {
    console.error('Get Shipments Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


/**
 * @desc    Get detailed shipment by ID + carrier tracking
 * @route   GET /api/v1/shipments/:id
 * @access  Private
 */
const getShipmentById = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    
    // Concurrently fetch shipment and carrier journey
    const [shipment, journey] = await Promise.all([
      Shipment.findOne({ shipmentId: id }),
      CarrierJourney.findOne({ shipmentId: id }).lean()
    ]);

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Verify user is either sender or receiver
    const userPhone = req.user.phone;
    const isSender = await isAuthorizedSenderOrSupplier(req.user, shipment);
    const isReceiver = shipment.receiverPhone === userPhone ||
      (userPhone && shipment.receiverPhone && shipment.receiverPhone.replace(/\D/g, '').endsWith(userPhone.replace(/\D/g, '').slice(-10)));

    if (!isSender && !isReceiver && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to view this shipment' });
    }

    // Auto-close return window if 24 hours have elapsed
    const activeShipment = await escrow.checkAndAutoCloseReturnWindow(shipment);

    res.json({
      shipment: activeShipment || shipment,
      journey: journey || null
    });
  } catch (error) {
    console.error('Get Shipment Details Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Create escrow shipment booking
 * @route   POST /api/v1/shipments
 * @access  Private
 */
const createShipment = async (req, res) => {
  const { 
    receiverName, receiverPhone, receiverAddress, description, amount, city, 
    fundEscrow, carrierSlug, awbCode, returnAllowed, paymentMode, 
    isPrepaid, photoReviewEnabled, rtoProtectionEnabled,
    senderPincode: bodyScenderPincode, receiverPincode: bodyReceiverPincode,
    senderAddress: bodySenderAddress,
    parcelWeight: bodyWeight,
    parcelLength: bodyLength,
    parcelWidth: bodyWidth,
    parcelHeight: bodyHeight
  } = req.body;

  try {
    if (!receiverName || !receiverPhone || !description || !amount) {
      return res.status(400).json({ error: 'Please enter receiver details, description, and amount' });
    }

    // SecureKaro rule: Sender MUST have verified mobile number before creating their first shipment
    const sender = req.user || await User.findById(req.user._id);
    if (!sender.phone || !sender.isPhoneVerified) {
      return res.status(403).json({ 
        error: 'Phone verification required',
        code: 'PHONE_VERIFICATION_REQUIRED',
        message: 'Mobile number verification is mandatory before creating shipments on SecureKaro. Please verify your phone number via OTP to ensure secure delivery coordination.'
      });
    }

    // Optional: If caller included bankDetails in payload, save it
    if (req.body.bankDetails && (req.body.bankDetails.accountNumber || req.body.bankDetails.upiId)) {
      sender.bankDetails = {
        accountHolderName: req.body.bankDetails.accountHolderName || sender.bankDetails?.accountHolderName || sender.fullName || '',
        accountNumber: req.body.bankDetails.accountNumber || sender.bankDetails?.accountNumber || '',
        ifscCode: req.body.bankDetails.ifscCode || sender.bankDetails?.ifscCode || '',
        bankName: req.body.bankDetails.bankName || sender.bankDetails?.bankName || '',
        upiId: req.body.bankDetails.upiId || sender.bankDetails?.upiId || ''
      };
      await sender.save();
    }

    const shipmentId = generateShipmentId();
    const isReturnAllowed = returnAllowed !== false;


    // ── Auto Carrier Selection: compare rates by pincode zone, pick cheapest ──
    const senderPincodeForRate = bodyScenderPincode || sender.pincode || sender.pickupAddress?.pincode || '';
    const receiverPincodeForRate = bodyReceiverPincode || '';
    const weightKgForRate = parseFloat(bodyWeight) || 0.5;
    const dimensionsForRate = {
      length: parseFloat(bodyLength) || 15,
      width: parseFloat(bodyWidth) || 10,
      height: parseFloat(bodyHeight) || 5
    };

    let assignedCarrierSlug;
    let assignedCarrierName;
    let selectedCarrierRate = null;
    let allCarrierQuotes = [];

    const checkIsCod = (paymentMode || '').toLowerCase() === 'cod';
    if (senderPincodeForRate && receiverPincodeForRate) {
      // Both pincodes present — run rate comparison with volumetric weight & live Shiprocket rates
      allCarrierQuotes = await getCarrierRatesAsync(senderPincodeForRate, receiverPincodeForRate, weightKgForRate, dimensionsForRate, false, checkIsCod);
    }

    // If caller explicitly passed a carrier, honour it; otherwise auto-select cheapest
    if (carrierSlug && carrierSlug !== 'add_later' && carrierSlug !== 'auto') {
      assignedCarrierSlug = carrierSlug.toLowerCase();
      const matched = allCarrierQuotes.find(q => q.slug === assignedCarrierSlug);
      assignedCarrierName = matched ? matched.name : (assignedCarrierSlug.charAt(0).toUpperCase() + assignedCarrierSlug.slice(1));
      selectedCarrierRate = matched ? matched.price : (Number(req.body.deliveryCharge) || 40);
      console.log(`[CARRIER] Manual selection: ${assignedCarrierSlug} (${assignedCarrierName}) @ ₹${selectedCarrierRate}`);
    } else if (allCarrierQuotes.length > 0) {
      const cheapest = allCarrierQuotes[0]; // Already sorted lowest first
      assignedCarrierSlug = cheapest.slug;
      assignedCarrierName = cheapest.name;
      selectedCarrierRate = cheapest.price;
      console.log(`[CARRIER] Auto-selected cheapest: ${cheapest.name} @ ₹${cheapest.price} (${senderPincodeForRate} → ${receiverPincodeForRate}, ${weightKgForRate}kg, dims: ${dimensionsForRate.length}x${dimensionsForRate.width}x${dimensionsForRate.height}cm)`);
    } else {
      // Fallback: pincodes not provided, use env default or delhivery
      assignedCarrierSlug = (process.env.DEFAULT_CARRIER || 'delhivery').toLowerCase();
      assignedCarrierName = 'Delhivery Express';
      console.log(`[CARRIER] Pincode unavailable, fallback to: ${assignedCarrierSlug}`);
    }

    const assignedAwbCode = awbCode && awbCode.trim() 
      ? awbCode.trim().toUpperCase() 
      : `TC-${assignedCarrierSlug}-${Math.floor(1000000000 + Math.random() * 9000000000)}`;

    const normalizedMode = (paymentMode || 'prepaid').toLowerCase();
    const isCod = normalizedMode === 'cod';
    const isOffline = normalizedMode === 'paid_offline';
    const isPrepaidOrder = normalizedMode === 'paid_offline' || isPrepaid === true;
    const shouldSkipPaymentLink = fundEscrow === true || normalizedMode === 'paid_offline' || isCod;

    // ── Negative Wallet Balance Risk Control ──────────────────────────────────
    // If seller wallet balance is negative, block COD and Offline Paid shipment bookings
    const currentWalletBal = Number(sender.walletBalance) || 0;
    if (currentWalletBal < 0 && (isCod || isOffline)) {
      return res.status(403).json({
        error: 'NEGATIVE_WALLET_BALANCE_RESTRICTION',
        code: 'NEGATIVE_WALLET_BLOCKED',
        walletBalance: currentWalletBal,
        dueAmount: Math.abs(currentWalletBal),
        message: `Your seller wallet balance is negative (-₹${Math.abs(currentWalletBal).toFixed(2)}). COD and Offline Paid shipment bookings are suspended until your outstanding dues are cleared. Please recharge your wallet via UPI or fulfill prepaid delivery-protected orders to unlock COD and offline shipping.`
      });
    }

    // ── COD Upfront Fee Calculation & Wallet Balance Adjustment ──
    let deliveryCharge = 0;
    let codCharge = 0;
    let totalCodFees = 0;
    let codFeePaid = false;
    let codFeePaymentMethod = 'none';
    let codFeePaidAt = null;
    let codFeeTransactionRef = '';

    if (isCod) {
      deliveryCharge = Number(req.body.deliveryCharge) || selectedCarrierRate || 40;
      codCharge = (req.body.codCharge !== undefined && !isNaN(Number(req.body.codCharge)) && Number(req.body.codCharge) >= 0)
        ? Number(req.body.codCharge)
        : 40;
      totalCodFees = Math.round(Number(deliveryCharge) + Number(codCharge));

      const availableWallet = Number(sender.walletBalance) || 0;
      const isPaidUpfront = Boolean(req.body.paidUpfront || req.body.codFeePaid || req.body.paymentTxnId);

      if (!isPaidUpfront) {
        if (availableWallet >= totalCodFees) {
          // Charge is <= wallet balance: Supplier adjusts it directly from wallet
          sender.walletBalance = parseFloat(Math.max(0, availableWallet - totalCodFees).toFixed(2));
          await sender.save();

          codFeePaid = true;
          codFeePaymentMethod = 'wallet_adjustment';
          codFeePaidAt = new Date();
          codFeeTransactionRef = 'WAL_' + Date.now();
        } else {
          // Charge is > wallet balance: Supplier must pay first then only shipment is created!
          return res.status(402).json({
            error: 'INSUFFICIENT_WALLET_BALANCE',
            code: 'COD_PAYMENT_REQUIRED',
            message: `COD shipment requires ₹${totalCodFees} upfront fee (Courier Delivery: ₹${deliveryCharge} + COD Handling: ₹${codCharge}). Your wallet balance is ₹${availableWallet}. Please pay ₹${totalCodFees} or top up your wallet to create this shipment.`,
            deliveryCharge,
            codCharge,
            totalCharge: totalCodFees,
            walletBalance: availableWallet,
            shortfall: Math.max(0, totalCodFees - availableWallet),
            canAdjustWallet: false
          });
        }
      } else {
        // Supplier paid the upfront fee via online gateway checkout
        codFeePaid = true;
        codFeePaymentMethod = 'online_gateway';
        codFeePaidAt = new Date();
        codFeeTransactionRef = req.body.paymentTxnId || ('TXN_' + Date.now());
      }
    }

    // Create Cashfree Payment Link ONLY for online escrow payment mode (skip for COD and Prepaid)
    let cfLink = { linkUrl: '', linkId: '' };
    if (!shouldSkipPaymentLink) {
      cfLink = await cashfreeService.createPaymentLink({
        shipmentId,
        amount,
        receiverName,
        receiverPhone,
        description,
        returnAllowed: isReturnAllowed
      });
    }

    // Generate SMS & WhatsApp text with parcel details, auto-assigned courier, and photo review links
    const smsRes = await smsService.sendPaymentLinkSms({
      phone: receiverPhone,
      shipmentId,
      amount,
      description,
      carrierSlug: assignedCarrierSlug,
      linkUrl: cfLink.linkUrl,
      returnAllowed: isReturnAllowed,
      receiverName,
      paymentMode: isCod ? 'cod' : isPrepaidOrder ? 'prepaid' : 'online',
      frontendUrl: process.env.FRONTEND_URL?.split(',')[0]
    });

    const senderAddressStr = req.body.senderAddress || sender.address || (sender.pickupAddress?.street ? `${sender.pickupAddress.street}${sender.pickupAddress.city ? ', ' + sender.pickupAddress.city : ''}${sender.pickupAddress.state ? ', ' + sender.pickupAddress.state : ''}${sender.pickupAddress.pincode ? ' - ' + sender.pickupAddress.pincode : ''}` : '');
    const senderPincodeStr = req.body.senderPincode || sender.pincode || sender.pickupAddress?.pincode || '';

    // Calculate platform service fee (1.6% or ₹10 min if order < ₹200)
    const feeCalc = calculateServiceFee(amount);

    const shipment = new Shipment({
      shipmentId,
      senderId: req.user._id,
      receiverName,
      receiverPhone,
      description,
      amount,
      serviceFeeDeducted: feeCalc.fee,
      serviceFeeRate: feeCalc.rate,
      city: city || "",
      senderAddress: senderAddressStr,
      senderPincode: senderPincodeStr,
      receiverAddress: receiverAddress || '',
      receiverPincode: bodyReceiverPincode || '',
      parcelWeight: parseFloat(bodyWeight) || 0.5,
      parcelLength: parseFloat(bodyLength) || 15,
      parcelWidth: parseFloat(bodyWidth) || 10,
      parcelHeight: parseFloat(bodyHeight) || 5,
      carrierSlug: assignedCarrierSlug,
      awbCode: shouldSkipPaymentLink ? assignedAwbCode : null,
      shippingLabelUrl: shouldSkipPaymentLink ? 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' : '',
      pickupStatus: shouldSkipPaymentLink ? 'Scheduled' : 'Pending Buyer Payment',
      paymentLink: cfLink.linkUrl,
      cashfreeLinkId: cfLink.linkId,
      returnAllowed: isReturnAllowed,
      paymentLinkSmsText: smsRes.smsText,
      paymentMode: isCod ? 'cod' : (paymentMode || 'prepaid'),
      isPrepaid: isPrepaidOrder,
      codAmount: isCod ? Number(amount) : 0,
      codCharge: isCod ? codCharge : 0,
      deliveryCharge: isCod ? deliveryCharge : (selectedCarrierRate || 0),
      codUpfrontFee: isCod ? totalCodFees : 0,
      codFeePaid: isCod ? codFeePaid : false,
      codFeePaymentMethod: isCod ? codFeePaymentMethod : 'none',
      codFeePaidAt: isCod ? codFeePaidAt : undefined,
      codFeeTransactionRef: isCod ? codFeeTransactionRef : '',
      photoReviewEnabled: true,
      photoReviewFee: 0,
      photoReviewRequested: true,
      photoReviewPaid: true,
      photoReviewRefused: false,
      rtoProtectionEnabled: (normalizedMode === 'prepaid') ? Boolean(rtoProtectionEnabled) : false,
      inboxQrToken: crypto.randomBytes(20).toString('hex'),
      inboxQrGeneratedAt: new Date(),
      inboxQrUsed: false,
      deliveryOtp: String(Math.floor(100000 + Math.random() * 900000)),
      deliveryOtpExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      deliveryOtpUsed: false,
      status: shouldSkipPaymentLink ? 'Pending Pickup' : 'Awaiting Payment',
      escrowStage: shouldSkipPaymentLink ? 3 : 1
    });

    if (shouldSkipPaymentLink) {
      shipment.receiverPaymentDone = isPrepaidOrder;
      if (isPrepaidOrder) shipment.receiverPaidAt = new Date();
    }

    await shipment.save();

    let pickupSchedule = null;

    let originLocation = "Primary Location";
    if (city) {
      if (city.includes('->')) originLocation = city.split('->')[0].trim();
      else if (city.includes('→')) originLocation = city.split('→')[0].trim();
    }

    if (shouldSkipPaymentLink) {
      // FOR COD & PAID OFFLINE:
      // Seller pays freight/fees upfront; book courier and auto-schedule pickup immediately
      pickupSchedule = await autoScheduleCourierPickup(shipment, sender);
      const logisticsData = await carrierTracking.bookShipment(shipment, sender);

      shipment.carrierSlug = logisticsData.carrierSlug || shipment.carrierSlug;
      shipment.awbCode = logisticsData.awbCode || shipment.awbCode;
      shipment.shippingLabelUrl = logisticsData.shippingLabelUrl || shipment.shippingLabelUrl;
      if (shipment.awbCode) {
        shipment.trackingSubmitted = true;
        shipment.trackingSubmittedAt = new Date();
        shipment.confirmationWindowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        shipment.confirmationWindowClosed = false;
      }
      await shipment.save();

      let initialJourney = await CarrierJourney.findOne({ shipmentId });
      if (!initialJourney) {
        const rateDetail = selectedCarrierRate ? ` at ₹${selectedCarrierRate} (cheapest available)` : '';
        initialJourney = new CarrierJourney({
          shipmentId,
          awbCode: shipment.awbCode,
          courierName: assignedCarrierName || assignedCarrierSlug.toUpperCase(),
          milestones: [
            {
              status: "Pending Pickup",
              location: originLocation,
              detail: `Order booked (${isCod ? 'COD' : 'Paid Offline'}) with ${assignedCarrierName || assignedCarrierSlug.toUpperCase()}${rateDetail}. AWB ${shipment.awbCode} auto-assigned. Courier pickup scheduled.`,
              time: new Date()
            }
          ]
        });
        await initialJourney.save();
      }

      await createNotification(
        req.user._id,
        'payments',
        `Shipment Booked — ${shipmentId}`,
        `Shipment (${isCod ? 'Cash on Delivery' : 'Paid Offline'}) booked for ${receiverName}. Courier: ${assignedCarrierName || assignedCarrierSlug.toUpperCase()} (AWB: ${shipment.awbCode}).`,
        'shipping'
      );

      const receiver = await findReceiverUser(receiverPhone);
      if (receiver) {
        await createNotification(
          receiver._id,
          'inventory_2',
          `Order Booked: ${shipmentId}`,
          `Your order from ${sender.fullName} is awaiting carrier pickup. (${isCod ? 'Pay on delivery: ₹' + amount : 'Prepaid order: ₹' + amount}).`,
          'shipping'
        );
      }
    } else {
      // FOR PREPAID ONLINE ORDERS:
      // Platform takes in all shipment details, generates secure buyer payment link.
      // Courier pickup and shipping label are automatically booked ONLY AFTER payment is received from the buyer.
      let initialJourney = await CarrierJourney.findOne({ shipmentId });
      if (!initialJourney) {
        initialJourney = new CarrierJourney({
          shipmentId,
          awbCode: 'PENDING_PAYMENT',
          courierName: assignedCarrierName || assignedCarrierSlug.toUpperCase(),
          milestones: [
            {
              status: "Awaiting Payment",
              location: originLocation,
              detail: `Order details registered. Secure payment link generated for buyer (₹${amount}). Courier pickup and AWB will be automatically booked once buyer payment is received.`,
              time: new Date()
            }
          ]
        });
        await initialJourney.save();
      }

      await createNotification(
        req.user._id,
        'add_box',
        `Order Registered — ${shipmentId}`,
        `Order details saved for ${receiverName}. Payment link generated. Courier pickup will be booked automatically after the buyer completes payment.`,
        'shipping'
      );
    }

    // COD Fee notification to supplier
    if (isCod && codFeePaid) {
      await createNotification(
        req.user._id,
        'account_balance_wallet',
        `COD Upfront Fee Settled — ${shipmentId}`,
        codFeePaymentMethod === 'wallet_adjustment'
          ? `₹${totalCodFees} (Courier Delivery: ₹${deliveryCharge} + COD Handling: ₹${codCharge}) adjusted from your wallet. Remaining balance: ₹${sender.walletBalance}.`
          : `₹${totalCodFees} paid online for COD delivery and handling fees.`,
        'wallet'
      );
    }

    // Refresh affected dashboard summaries
    invalidateDashboardCache();

    res.status(201).json({
      ...shipment.toObject(),
      serviceFee: feeCalc.fee,
      serviceFeeRate: feeCalc.rate,
      serviceFeeNote: feeCalc.note,
      netDisbursementPreview: Math.max(0, parseFloat((amount - feeCalc.fee).toFixed(2))),
      codCharge: shipment.codCharge,
      deliveryCharge: shipment.deliveryCharge,
      codUpfrontFee: shipment.codUpfrontFee,
      codFeePaid: shipment.codFeePaid,
      codFeePaymentMethod: shipment.codFeePaymentMethod,
      walletBalanceRemaining: sender.walletBalance,
      autoScheduledPickup: pickupSchedule,
      pickupToken: shipment.pickupToken,
      pickupSlot: shipment.pickupSlot,
      pickupCarrier: shipment.pickupCarrier,
      pickupCarrierSlug: shipment.pickupCarrierSlug,
      pickupRate: shipment.pickupRate,
      pickupAgentName: shipment.pickupAgentName,
      pickupAgentPhone: shipment.pickupAgentPhone,
      pickupRateComparison: shipment.pickupRateComparison,
      autoSelectedCarrier: {
        slug: shipment.pickupCarrierSlug || assignedCarrierSlug,
        name: shipment.pickupCarrier || assignedCarrierName || assignedCarrierSlug.toUpperCase(),
        shippingRate: shipment.pickupRate || selectedCarrierRate,
        allQuotes: allCarrierQuotes.map(q => ({
          slug: q.slug,
          name: q.name,
          price: q.price,
          eta: q.eta,
          isSelected: q.slug === (shipment.pickupCarrierSlug || assignedCarrierSlug)
        }))
      }
    });
  } catch (error) {
    console.error('Create Shipment Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Quote upfront COD fees (courier delivery + COD charge) & check wallet adjustability
 * @route   POST /api/v1/shipments/quote-cod
 * @access  Private
 */
const quoteCodFees = async (req, res) => {
  try {
    const { 
      amount = 0, 
      senderPincode: bodySenderPincode, 
      receiverPincode: bodyReceiverPincode, 
      parcelWeight: bodyWeight = 0.5,
      parcelLength: bodyLength = 15,
      parcelWidth: bodyWidth = 10,
      parcelHeight: bodyHeight = 5,
      carrierSlug = 'auto',
      codCharge: bodyCodCharge
    } = req.body;

    const user = req.user || await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const fromPincode = bodySenderPincode || user.pincode || user.pickupAddress?.pincode || '';
    const toPincode = bodyReceiverPincode || '';
    const weightKg = parseFloat(bodyWeight) || 0.5;
    const dimensionsForRate = {
      length: parseFloat(bodyLength) || 15,
      width: parseFloat(bodyWidth) || 10,
      height: parseFloat(bodyHeight) || 5
    };

    let deliveryCharge = 40; // Default fallback
    let carrierName = 'Delhivery Express';
    let carrierQuotes = [];

    if (fromPincode && toPincode) {
      carrierQuotes = await getCarrierRatesAsync(fromPincode, toPincode, weightKg, dimensionsForRate, false, true);
      if (carrierQuotes && carrierQuotes.length > 0) {
        if (carrierSlug && carrierSlug !== 'auto' && carrierSlug !== 'add_later') {
          const matched = carrierQuotes.find(q => q.slug === carrierSlug.toLowerCase());
          if (matched) {
            deliveryCharge = matched.price;
            carrierName = matched.name;
          } else {
            deliveryCharge = carrierQuotes[0].price;
            carrierName = carrierQuotes[0].name;
          }
        } else {
          deliveryCharge = carrierQuotes[0].price;
          carrierName = carrierQuotes[0].name;
        }
      }
    }

    const codCharge = (bodyCodCharge !== undefined && !isNaN(Number(bodyCodCharge)) && Number(bodyCodCharge) >= 0)
      ? Number(bodyCodCharge)
      : 40;

    const totalCharge = Math.round(deliveryCharge + codCharge);
    const walletBalance = Number(user.walletBalance) || 0;
    const canAdjustWallet = walletBalance >= totalCharge;
    const shortfall = Math.max(0, totalCharge - walletBalance);

    res.json({
      success: true,
      deliveryCharge,
      codCharge,
      totalCharge,
      walletBalance,
      canAdjustWallet,
      shortfall,
      carrierSlug: carrierSlug || 'auto',
      carrierName,
      allQuotes: carrierQuotes
    });
  } catch (err) {
    console.error('Quote COD Fees Error:', err);
    res.status(500).json({ error: err.message || 'Failed to quote COD fees' });
  }
};

/**
 * @desc    Fund escrow for an existing Stage 1 shipment
 * @route   POST /api/v1/shipments/:id/fund
 * @access  Private
 */
const fundShipment = async (req, res) => {
  const { carrierSlug, awbCode } = req.body;

  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // IDOR Protection: Verify caller is the intended receiver, sender, or admin
    const isReceiver = shipment.receiverPhone === req.user.phone ||
      (req.user.phone && shipment.receiverPhone && shipment.receiverPhone.replace(/\D/g, '').endsWith(req.user.phone.replace(/\D/g, '').slice(-10)));
    const isSender = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isReceiver && !isSender && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to fund this shipment' });
    }

    if (shipment.escrowStage !== 1 && shipment.receiverPaymentDone) {
      return res.status(400).json({ error: 'Shipment has already been funded or processed' });
    }

    if (carrierSlug) shipment.carrierSlug = carrierSlug;
    if (awbCode) shipment.awbCode = awbCode;

    const updatedShipment = await executeOrderPaymentAndCourierBooking(shipment, req.body);
    res.json(updatedShipment);
  } catch (error) {
    console.error('Fund Escrow Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Core engine: Creates courier shipment, books pickup, generates AWB & label
 *          after payment is received from the buyer.
 */
const executeOrderPaymentAndCourierBooking = async (shipment, paymentDetails = {}) => {
  if (!shipment) return null;

  // If already paid and booked, return existing shipment
  if (shipment.status !== 'Awaiting Payment' && shipment.escrowStage >= 3 && shipment.receiverPaymentDone) {
    return shipment;
  }

  const sender = (shipment.senderId && typeof shipment.senderId === 'object' && shipment.senderId.phone)
    ? shipment.senderId
    : await User.findById(shipment.senderId);

  // Selected courier partner (from buyer checkout selection or seller preference)
  const chosenCarrierSlug = (paymentDetails.carrierSlug || shipment.carrierSlug || process.env.DEFAULT_CARRIER || 'delhivery').toLowerCase();
  shipment.carrierSlug = chosenCarrierSlug;

  // Update status: payment is now verified
  shipment.status = 'Pending Pickup';
  shipment.escrowStage = 3;
  shipment.receiverPaymentDone = true;
  shipment.receiverPaidAt = new Date();
  if (paymentDetails.transactionRef) {
    shipment.paymentTransactionRef = paymentDetails.transactionRef;
  }

  // 1. Auto-schedule courier pickup slot using the courier company the buyer selected
  const pickupSchedule = await autoScheduleCourierPickup(shipment, sender, chosenCarrierSlug);

  // 2. Trigger carrier booking to generate real AWB and shipping label for the chosen carrier
  const logisticsData = await carrierTracking.bookShipment(shipment, sender, chosenCarrierSlug);

  shipment.carrierSlug = logisticsData.carrierSlug || pickupSchedule?.carrierSlug || chosenCarrierSlug;
  shipment.awbCode = logisticsData.awbCode || pickupSchedule?.pickupToken || shipment.awbCode;
  shipment.shippingLabelUrl = logisticsData.shippingLabelUrl || shipment.shippingLabelUrl || 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';
  shipment.pickupCarrier = pickupSchedule?.carrier || (chosenCarrierSlug === 'bluedart' ? 'Blue Dart Express' : (chosenCarrierSlug === 'delhivery' ? 'Delhivery Express' : (chosenCarrierSlug.charAt(0).toUpperCase() + chosenCarrierSlug.slice(1))));

  if (shipment.awbCode) {
    shipment.trackingSubmitted = true;
    shipment.trackingSubmittedAt = new Date();
    shipment.confirmationWindowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    shipment.confirmationWindowClosed = false;
  }
  await shipment.save();

  // 3. Upsert Carrier Journey milestone
  let origin = "Primary Location";
  if (shipment.city) {
    if (shipment.city.includes('->')) origin = shipment.city.split('->')[0].trim();
    else if (shipment.city.includes('→')) origin = shipment.city.split('→')[0].trim();
  }

  const courierTitle = shipment.pickupCarrier || (chosenCarrierSlug === 'bluedart' ? 'Blue Dart Express' : 'Delhivery Express');
  const milestoneDetail = `Buyer payment of ₹${shipment.amount} received. Carrier Booked: ${courierTitle} (AWB: ${shipment.awbCode}). Pickup slot: ${shipment.pickupSlot || 'Scheduled'}.`;

  let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
  if (!journey) {
    journey = new CarrierJourney({
      shipmentId: shipment.shipmentId,
      awbCode: shipment.awbCode,
      courierName: courierTitle,
      milestones: [
        {
          status: "Pending Pickup",
          location: origin,
          detail: milestoneDetail,
          time: new Date()
        }
      ]
    });
  } else {
    journey.awbCode = shipment.awbCode || journey.awbCode;
    journey.courierName = courierTitle;
    journey.milestones.push({
      status: "Pending Pickup",
      location: origin,
      detail: milestoneDetail,
      time: new Date()
    });
  }
  await journey.save();

  // 4. Create notifications in parallel
  const senderIdForNotify = shipment.senderId?._id || shipment.senderId;
  const notificationPromises = [
    createNotification(
      senderIdForNotify,
      'payments',
      `Payment Received — Carrier Booked: ${courierTitle} (${shipment.shipmentId})`,
      `Buyer has completed payment of ₹${shipment.amount}. Courier shipment created with ${courierTitle} (AWB: ${shipment.awbCode}). Carrier Booked: ${courierTitle}. Pickup scheduled. Please print shipping label.`,
      'shipping'
    )
  ];

  const receiver = await findReceiverUser(shipment.receiverPhone);
  if (receiver) {
    notificationPromises.push(
      createNotification(
        receiver._id,
        'inventory_2',
        `Payment Successful — Carrier Booked: ${courierTitle}`,
        `Your payment of ₹${shipment.amount} is confirmed. Courier shipment created with your selected carrier: ${courierTitle} (AWB: ${shipment.awbCode}).`,
        'shipping'
      )
    );
  }
  await Promise.allSettled(notificationPromises);

  // 6. Grant Payment Link Prepayment Cashback (Fixed ₹5 per Option B)
  try {
    const cashbackResult = await grantPrepaymentCashback(shipment.shipmentId, shipment.receiverPhone);
    if (cashbackResult?.success) {
      console.log(`[PAYMENT LINK] Prepayment cashback ₹${cashbackResult.amount} granted to buyer ${shipment.receiverPhone}`);
      shipment.prepaymentCashback = cashbackResult;
    }
  } catch (cbErr) {
    console.warn('[PAYMENT LINK] Prepayment cashback grant note (non-blocking):', cbErr.message);
  }

  return shipment;
};

/**
 * @desc    Public payment completion (when buyer pays via public payment link or simulated checkout)
 * @route   POST /api/v1/shipments/public/pay/:id
 * @access  Public
 */
const publicPayShipment = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (shipment.receiverPaymentDone && shipment.escrowStage >= 3) {
      return res.json({ 
        message: 'Payment already completed for this order',
        shipment 
      });
    }

    // In production, verify with Cashfree that the payment was genuinely completed
    if (process.env.NODE_ENV === 'production' && shipment.cashfreeLinkId) {
      try {
        const linkDetails = await cashfreeService.getPaymentLinkDetails(shipment.cashfreeLinkId);
        const linkStatus = linkDetails?.data?.link_status || linkDetails?.status;
        if (linkStatus !== 'PAID' && linkStatus !== 'COMPLETED') {
          return res.status(400).json({
            error: 'Payment has not been confirmed by the payment gateway yet. Please complete checkout.',
            paymentLink: shipment.paymentLink
          });
        }
      } catch (cfErr) {
        console.warn('[Public Pay] Cashfree link verification error:', cfErr.message);
      }
    }

    const updatedShipment = await executeOrderPaymentAndCourierBooking(shipment, {
      transactionRef: req.body.transactionRef || `PAY_${Date.now()}`,
      gateway: req.body.gateway || 'integrated_gateway',
      carrierSlug: req.body.carrierSlug
    });

    res.status(200).json({
      success: true,
      message: 'Payment verified and courier shipment booked successfully',
      shipment: updatedShipment,
      cashback: updatedShipment?.prepaymentCashback || null
    });
  } catch (error) {
    console.error('Public Pay Error:', error);
    res.status(500).json({ error: 'Failed to process payment and book courier shipment' });
  }
};

/**
 * @desc    Payment gateway webhook (Cashfree / PhonePe / Easebuzz)
 * @route   POST /api/v1/shipments/webhook/payment
 * @access  Public
 */
const paymentWebhookHandler = async (req, res) => {
  try {
    const event = req.body;
    console.log('[Shipment Payment Webhook] Received payment event:', event?.type || 'event');

    // SECURITY: Verify Cashfree webhook HMAC signature if header is present
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    if (signature && process.env.CASHFREE_SECRET_KEY) {
      const rawPayload = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
      const isValid = cashfreeService.verifyCashfreeWebhookSignature(rawPayload, signature, timestamp);
      if (!isValid && process.env.NODE_ENV === 'production') {
        console.warn('[Shipment Webhook] Invalid HMAC signature received — rejecting webhook.');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const targetRef = event?.data?.order?.order_id || 
                      event?.data?.payment_link_id || 
                      event?.order_id || 
                      event?.link_id ||
                      event?.txnid;

    if (targetRef) {
      const cleanRef = String(targetRef).toUpperCase();
      const shipment = await Shipment.findOne({
        $or: [
          { shipmentId: cleanRef },
          { cashfreeLinkId: targetRef },
          { shipmentId: cleanRef.replace(/^SPL_/, '').replace(/^ORD_/, '') }
        ]
      });

      if (shipment && !shipment.receiverPaymentDone) {
        await executeOrderPaymentAndCourierBooking(shipment, {
          transactionRef: event?.data?.payment?.cf_payment_id || event?.payment_id || `WH_${Date.now()}`,
          gateway: 'gateway_webhook'
        });
        console.log(`[Shipment Payment Webhook] Successfully booked courier for ${shipment.shipmentId}`);
      }
    }

    res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('[Shipment Payment Webhook] Error:', error);
    res.status(200).json({ status: 'OK' });
  }
};

/**
 * @desc    Submit courier tracking ID and dispatch parcel (by Supplier)
 * @route   PUT /api/v1/shipments/:id/dispatch
 * @access  Private
 */
const dispatchShipment = async (req, res) => {
  const { carrierSlug, awbCode, parcelPhotoUrl } = req.body;
  const id = req.params.id.toUpperCase();

  try {
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Verify sender / supplier
    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isSupplierAuth) {
      return res.status(403).json({ error: 'Only the supplier / sender can submit courier tracking ID' });
    }

    if (!awbCode || !awbCode.trim()) {
      return res.status(400).json({ error: 'Please enter a valid courier tracking ID / AWB code' });
    }

    // Enforce Parcel Photo upload for all shipments before dispatch
    const hasPhoto = (parcelPhotoUrl && parcelPhotoUrl.trim()) || (shipment.parcelPhotoUrl && shipment.parcelPhotoUrl.trim());
    if (!hasPhoto) {
      return res.status(400).json({ 
        error: 'Parcel & product photo is mandatory for all shipments before dispatch.' 
      });
    }

    if (parcelPhotoUrl && parcelPhotoUrl.trim()) {
      if (shipment.parcelPhotoUploadedAt && shipment.parcelPhotoUrl && parcelPhotoUrl.trim() !== shipment.parcelPhotoUrl) {
        const tenMinutes = 10 * 60 * 1000;
        const elapsed = Date.now() - new Date(shipment.parcelPhotoUploadedAt).getTime();
        if (elapsed > tenMinutes) {
          return res.status(400).json({ 
            error: 'The 10-minute retake window for parcel photo has expired. You can no longer change or retake this photo.' 
          });
        }
      }
      shipment.parcelPhotoUrl = parcelPhotoUrl.trim();
      shipment.parcelPhotoUploadedAt = shipment.parcelPhotoUploadedAt || new Date();
    }

    shipment.carrierSlug = carrierSlug || shipment.carrierSlug || 'delhivery';
    shipment.awbCode = awbCode.trim().toUpperCase();
    shipment.trackingSubmitted = true;
    shipment.trackingSubmittedAt = new Date();

    if (shipment.status === 'Pending Pickup' || shipment.status === 'Awaiting Payment') {
      shipment.status = 'In Transit';
      shipment.escrowStage = 4;
    }

    // Check if receiver payment is done
    const isPaymentDone = shipment.escrowStage >= 2 || shipment.status !== 'Awaiting Payment' || shipment.receiverPaymentDone;
    if (isPaymentDone) {
      shipment.receiverPaymentDone = true;
      if (!shipment.receiverPaidAt) shipment.receiverPaidAt = new Date();
      // 24-hour buyer confirmation window starts
      shipment.confirmationWindowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      shipment.confirmationWindowClosed = false;
    }

    // ── Generate unique In-Box QR Token & 6-digit Delivery OTP ──────────────
    if (!shipment.inboxQrToken) {
      const qrToken = crypto.randomBytes(20).toString('hex');
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      shipment.inboxQrToken = qrToken;
      shipment.inboxQrGeneratedAt = new Date();
      shipment.inboxQrUsed = false;
      shipment.deliveryOtp = otp;
      shipment.deliveryOtpExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days validity
      shipment.deliveryOtpUsed = false;
    }

    await shipment.save();

    // Update CarrierJourney
    let journey = await CarrierJourney.findOne({ shipmentId: id });
    if (!journey) {
      journey = new CarrierJourney({
        shipmentId: id,
        awbCode: shipment.awbCode,
        courierName: shipment.carrierSlug.toUpperCase(),
        milestones: []
      });
    }
    journey.awbCode = shipment.awbCode;
    journey.courierName = shipment.carrierSlug.toUpperCase();
    journey.milestones.push({
      status: 'In Transit',
      location: shipment.city || 'Carrier Facility',
      detail: `Courier tracking ID ${shipment.awbCode} registered by supplier via ${shipment.carrierSlug.toUpperCase()}. 24-hour confirmation window initiated.`,
      time: new Date()
    });
    await journey.save();

    // Create notifications for sender
    await createNotification(
      shipment.senderId,
      'local_shipping',
      `Tracking Registered: ${shipment.shipmentId}`,
      `Tracking ID ${shipment.awbCode} submitted. Parcel value (₹${shipment.amount}) will become withdrawable once the 24-hour confirmation window closes.`,
      'shipping'
    );

    // Compute public zero-login tracking URL for receiver
    const frontendBase = req.headers.origin || (process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').find(u => u.includes('3001')) || process.env.FRONTEND_URL.split(',')[0] : 'http://localhost:3001');
    const rawPhone = (shipment.receiverPhone || '').replace(/\D/g, '');
    const trackUrl = `${frontendBase}/track/${shipment.shipmentId}${rawPhone ? `?phone=${rawPhone.slice(-10)}` : ''}`;

    // Automatically dispatch tracking alert to Receiver via WhatsApp
    try {
      await whatsappService.sendDispatchTrackingWhatsApp({
        phone: shipment.receiverPhone,
        receiverName: shipment.receiverName,
        shipmentId: shipment.shipmentId,
        carrierName: shipment.carrierSlug?.toUpperCase() || 'Courier Partner',
        awbCode: shipment.awbCode,
        trackUrl,
        description: shipment.description
      });
    } catch (waErr) {
      console.error('[DISPATCH] WhatsApp notification failed (non-blocking):', waErr.message);
    }

    // Automatically dispatch tracking alert to Receiver via SMS
    try {
      await smsService.sendDispatchTrackingSms({
        phone: shipment.receiverPhone,
        shipmentId: shipment.shipmentId,
        receiverName: shipment.receiverName,
        carrierSlug: shipment.carrierSlug,
        awbCode: shipment.awbCode,
        trackUrl
      });
    } catch (smsErr) {
      console.error('[DISPATCH] SMS notification failed (non-blocking):', smsErr.message);
    }

    // In-app notification for receiver if registered on SecureKaro
    if (rawPhone.length >= 10) {
      try {
        const receiverUser = await User.findOne({
          phone: new RegExp(rawPhone.slice(-10) + '$')
        });
        if (receiverUser && receiverUser._id) {
          await createNotification(
            receiverUser._id,
            'local_shipping',
            `Parcel Dispatched: ${shipment.shipmentId}`,
            `Your parcel has been dispatched with ${shipment.carrierSlug?.toUpperCase() || 'courier'} (AWB: ${shipment.awbCode}). Track live: ${trackUrl}`,
            'shipping'
          );
        }
      } catch (notifErr) {
        console.error('[DISPATCH] In-app receiver notification failed (non-blocking):', notifErr.message);
      }
    }

    res.json({
      message: 'Courier tracking details registered successfully',
      shipment,
      confirmationWindowExpiresAt: shipment.confirmationWindowExpiresAt
    });
  } catch (error) {
    console.error('Dispatch Shipment Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Release escrow funds to Sender (called by Receiver)
 * @route   PUT /api/v1/shipments/:id/release
 * @access  Private
 */
const releaseShipment = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Verify caller is the receiver
    if (!isAuthorizedReceiver(req.user, shipment)) {
      return res.status(403).json({ error: 'Only the receiver can release these order funds' });
    }

    const updatedShipment = await escrow.releaseEscrow(id, req.user._id);
    res.json(updatedShipment);
  } catch (error) {
    console.error('Release Escrow Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Cancel shipment & refund escrow
 * @route   PUT /api/v1/shipments/:id/cancel
 * @access  Private
 */
const cancelShipment = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { reason } = req.body;
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    const isSender = await isAuthorizedSenderOrSupplier(req.user, shipment);
    const isReceiver = shipment.receiverPhone === req.user.phone ||
      (req.user.phone && shipment.receiverPhone && shipment.receiverPhone.replace(/\D/g, '').endsWith(req.user.phone.replace(/\D/g, '').slice(-10)));

    if (!isSender && !isReceiver && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to cancel this shipment' });
    }

    const updatedShipment = await escrow.cancelEscrow(id, req.user._id, reason || 'User requested cancellation');
    res.json(updatedShipment);
  } catch (error) {
    console.error('Cancel Shipment Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Mark shipment as undelivered & refund escrow principal to receiver
 * @route   PUT /api/v1/shipments/:id/undelivered
 * @access  Private
 */
const markUndelivered = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { reason } = req.body;
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    const isSender = await isAuthorizedSenderOrSupplier(req.user, shipment);
    const isReceiver = shipment.receiverPhone === req.user.phone ||
      (req.user.phone && shipment.receiverPhone && shipment.receiverPhone.replace(/\D/g, '').endsWith(req.user.phone.replace(/\D/g, '').slice(-10)));

    if (!isSender && !isReceiver && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to report undelivered status for this shipment' });
    }

    const result = await escrow.refundUndeliveredEscrow(id, reason || 'Carrier delivery failed or returned to origin');
    res.json(result);
  } catch (error) {
    console.error('Mark Undelivered Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Request return & generate Reverse AWB (REV-SPL-XXXX)
 * @route   PUT /api/v1/shipments/:id/return-request
 * @access  Private
 */
const requestReturn = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { reason, returnType, defectPhotoUrl, defectDescription, bankDetails } = req.body;
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // IDOR Protection: Only the authorized receiver or Admin can initiate a return
    const isReceiverAuth = isAuthorizedReceiver(req.user, shipment);
    if (!isReceiverAuth && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the receiver or admin can request a return for this shipment' });
    }

    // Save Bank Details if submitted
    const currentUser = await User.findById(req.user._id);
    if (bankDetails && (bankDetails.accountNumber || bankDetails.upiId)) {
      if (currentUser) {
        if (!currentUser.bankDetails) currentUser.bankDetails = {};
        if (bankDetails.accountHolderName) currentUser.bankDetails.accountHolderName = bankDetails.accountHolderName.trim();
        if (bankDetails.accountNumber) currentUser.bankDetails.accountNumber = bankDetails.accountNumber.trim();
        if (bankDetails.ifscCode) currentUser.bankDetails.ifscCode = bankDetails.ifscCode.trim().toUpperCase();
        if (bankDetails.bankName) currentUser.bankDetails.bankName = bankDetails.bankName.trim();
        if (bankDetails.upiId) currentUser.bankDetails.upiId = bankDetails.upiId.trim();
        await currentUser.save();
      }
    }

    // Mandatory Bank Details Check for full refund
    const effectiveType = returnType || 'full_refund';
    const hasValidBank = currentUser && currentUser.bankDetails && (
      (currentUser.bankDetails.accountNumber && currentUser.bankDetails.accountNumber.trim().length >= 6) ||
      (currentUser.bankDetails.upiId && currentUser.bankDetails.upiId.trim().includes('@'))
    );

    if (effectiveType === 'full_refund' && !hasValidBank) {
      return res.status(400).json({
        error: 'Mandatory bank details missing. Please enter and save your Bank Account or UPI ID to receive your order refund.'
      });
    }

    // Mandatory Photo Proof Check across all return types (full_refund, partial_discount, replacement)
    if (!defectPhotoUrl || typeof defectPhotoUrl !== 'string' || !defectPhotoUrl.trim()) {
      return res.status(400).json({
        error: 'Uploading photo proof of the package/item is mandatory for refund, partial return, and replacement requests.'
      });
    }

    const updatedShipment = await escrow.requestReturnEscrow(
      id,
      req.user._id,
      reason || 'Receiver requested return',
      returnType || 'full_refund',
      defectPhotoUrl || '',
      defectDescription || ''
    );
    res.json(updatedShipment);
  } catch (error) {
    console.error('Request Return Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Supplier approves return & sets reverse courier in transit
 * @route   PUT /api/v1/shipments/:id/return-approve
 * @access  Private
 */
const approveReturn = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // IDOR Protection: Only the supplier/sender or admin can approve a return
    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isSupplierAuth) {
      return res.status(403).json({ error: 'Only the supplier can approve a return for this shipment' });
    }

    // Partial Discount Protection: reverse courier can only be booked if buyer rejects the discount offer
    if (shipment.returnType === 'partial_discount') {
      if (shipment.discountAccepted === true) {
        return res.status(400).json({ error: 'Partial discount has already been accepted by the buyer. The buyer keeps the product, so no reverse courier is needed.' });
      }
      if (shipment.discountAccepted !== false) {
        return res.status(400).json({ error: 'Cannot book reverse courier for a partial discount return until the buyer responds. If the buyer accepts your offer, they keep the product.' });
      }
    }

    const { carrierSlug, carrierName, trackingId, notes, pickupWindow } = req.body || {};
    const updatedShipment = await escrow.approveReturnEscrow(
      id,
      { carrierSlug, carrierName, trackingId, notes, pickupWindow },
      req.user._id
    );
    res.json({
      ...updatedShipment.toObject(),
      shipment: updatedShipment,
      success: true,
      autoBooked: updatedShipment.returnAutoBooked,
      cheapestCarrier: updatedShipment.returnCarrierName,
      shippingRate: updatedShipment.returnShippingRate,
      estimatedSavings: updatedShipment.returnEstimatedSavings,
      pickupWindow: updatedShipment.returnPickupWindow,
      trackingId: updatedShipment.returnAwbCode,
      message: updatedShipment.returnAutoBooked
        ? `Return approved! Reverse courier automatically booked with ${updatedShipment.returnCarrierName} at lowest reverse rate (₹${updatedShipment.returnShippingRate || 55}). Reverse courier fee will be charged to seller account upon return delivery confirmation. Scheduled pickup: ${updatedShipment.returnPickupWindow}. Buyer notified.`
        : `Return approved and reverse courier ${updatedShipment.returnCarrierName || 'partner'} assigned successfully. Receiver notified.`
    });
  } catch (error) {
    console.error('Approve Return Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Confirm return arrival at supplier warehouse & refund receiver
 * @route   PUT /api/v1/shipments/:id/return-confirm
 * @access  Private
 */
const confirmReturnReceived = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // IDOR Protection: Only the supplier/sender or admin can confirm receipt of a returned shipment
    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isSupplierAuth) {
      return res.status(403).json({ error: 'Only the supplier can confirm receipt of a returned shipment' });
    }

    const updatedShipment = await escrow.confirmReturnReceivedEscrow(id);
    res.json(updatedShipment);
  } catch (error) {
    console.error('Confirm Return Received Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Generate / Get Cashfree Receiver Payment Link
 * @route   POST /api/v1/shipments/:id/payment-link
 * @access  Private
 */
const generatePaymentLink = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // IDOR Protection: Only the sender, receiver, or admin can access the payment link
    const isSender = await isAuthorizedSenderOrSupplier(req.user, shipment);
    const isReceiver = shipment.receiverPhone === req.user.phone ||
      (req.user.phone && shipment.receiverPhone && shipment.receiverPhone.replace(/\D/g, '').endsWith(req.user.phone.replace(/\D/g, '').slice(-10)));
    if (!isSender && !isReceiver && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to access payment links for this shipment' });
    }

    if (!shipment.paymentLink) {
      const cfLink = await cashfreeService.createPaymentLink({
        shipmentId: shipment.shipmentId,
        amount: shipment.amount,
        receiverName: shipment.receiverName,
        receiverPhone: shipment.receiverPhone,
        description: shipment.description
      });

      shipment.paymentLink = cfLink.linkUrl;
      shipment.cashfreeLinkId = cfLink.linkId;

      const smsRes = await smsService.sendPaymentLinkSms({
        phone: shipment.receiverPhone,
        shipmentId: shipment.shipmentId,
        amount: shipment.amount,
        description: shipment.description,
        carrierSlug: shipment.carrierSlug,
        linkUrl: shipment.paymentLink,
        returnAllowed: shipment.returnAllowed !== false
      });
      shipment.paymentLinkSmsText = smsRes.smsText;

      await shipment.save();
    }

    res.json({
      shipmentId: shipment.shipmentId,
      amount: shipment.amount,
      receiverName: shipment.receiverName,
      receiverPhone: shipment.receiverPhone,
      paymentLink: shipment.paymentLink,
      cashfreeLinkId: shipment.cashfreeLinkId,
      returnAllowed: shipment.returnAllowed !== false,
      paymentLinkSmsText: shipment.paymentLinkSmsText,
      status: 'SUCCESS'
    });
  } catch (error) {
    console.error('Generate Payment Link Error:', error);
    res.status(500).json({ error: 'Failed to generate Cashfree payment link' });
  }
};

/**
 * @desc    Confirm parcel delivery by receiver (with 2 options: immediate close vs 24h return window)
 * @route   PUT /api/v1/shipments/:id/confirm-delivery
 * @access  Private
 */
const confirmDeliveryHandler = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { choice } = req.body; // 'immediate' or 'keep_open_24h'
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Verify caller is the receiver
    if (!isAuthorizedReceiver(req.user, shipment)) {
      return res.status(403).json({ error: 'Only the receiver can confirm parcel delivery' });
    }

    // Check if parcel delivery has already been confirmed (either with window closed or open)
    if (shipment.deliveryConfirmed || shipment.status === 'Released') {
      const isClosed = shipment.returnWindowClosed || shipment.status === 'Released' || shipment.returnWindowChoice === 'ImmediateClose';
      const isExpired = shipment.returnWindowExpiresAt && new Date() >= new Date(shipment.returnWindowExpiresAt);
      const windowDetail = isClosed
        ? 'Return window is closed and order payment has been released.'
        : isExpired
          ? 'The 24-hour return window has expired.'
          : `24-hour return window is currently active until ${new Date(shipment.returnWindowExpiresAt).toLocaleString('en-IN')}.`;
      return res.status(400).json({
        error: `Parcel already confirmed. ${windowDetail}`,
        alreadyConfirmed: true,
        deliveryConfirmedAt: shipment.deliveryConfirmedAt || shipment.inboxQrConfirmedAt,
        returnWindowClosed: isClosed,
        returnWindowExpiresAt: shipment.returnWindowExpiresAt,
        returnWindowChoice: shipment.returnWindowChoice,
        status: shipment.status
      });
    }

    const result = await escrow.confirmDelivery(id, req.user._id, { choice: choice || 'keep_open_24h' });
    res.json(result);
  } catch (error) {
    console.error('Confirm Delivery Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Receiver closes / withdraws their active return request
 * @route   PUT /api/v1/shipments/:id/return-close
 * @access  Private
 */
const closeReturnRequestHandler = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Verify caller is the receiver
    if (!isAuthorizedReceiver(req.user, shipment)) {
      return res.status(403).json({ error: 'Only the receiver can close their return request' });
    }

    const result = await escrow.closeReturnRequest(id, req.user._id);
    res.json(result);
  } catch (error) {
    console.error('Close Return Request Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Receiver closes 24-hour return window early and releases escrow
 * @route   PUT /api/v1/shipments/:id/return-window-close
 * @access  Private
 */
const closeReturnWindowHandler = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Verify caller is the receiver
    if (!isAuthorizedReceiver(req.user, shipment)) {
      return res.status(403).json({ error: 'Only the receiver can close the return window' });
    }

    const result = await escrow.closeReturnWindow(id, req.user._id);
    res.json(result);
  } catch (error) {
    console.error('Close Return Window Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Simulate tracking delivery status (Testing & Carrier Webhook Simulator)
 * @route   PUT /api/v1/shipments/:id/simulate-delivered
 * @access  Private
 */
const simulateDelivered = async (req, res) => {
  try {
    // SECURITY: Delivery simulation must NEVER be exposed publicly in production
    if (process.env.NODE_ENV === 'production' && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Delivery simulation endpoints are disabled in production.' });
    }

    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // IDOR check: caller must be admin, sender, or receiver
    const isReceiver = req.user.phone && shipment.receiverPhone && shipment.receiverPhone.replace(/\D/g, '').endsWith(req.user.phone.replace(/\D/g, '').slice(-10));
    const isSender = shipment.senderId && shipment.senderId.toString() === req.user._id.toString();
    if (!req.user.isAdmin && !isReceiver && !isSender) {
      return res.status(403).json({ error: 'Not authorized to simulate delivery on this shipment.' });
    }

    shipment.status = 'Delivered';
    shipment.escrowStage = 5;
    await shipment.save();

    // Add milestone to journey
    let journey = await CarrierJourney.findOne({ shipmentId: id });
    if (journey) {
      journey.milestones.push({
        status: 'Delivered',
        location: shipment.city ? shipment.city.split('->').pop().trim() : 'Destination Hub',
        detail: 'Package delivered to recipient address. Awaiting parcel confirmation.',
        time: new Date()
      });
      await journey.save();
    }

    // Send delivered notification to receiver to confirm parcel
    const receiver = await findReceiverUser(shipment.receiverPhone);
    if (receiver) {
      await createNotification(
        receiver._id,
        'inventory_2',
        `Parcel Delivered — Action Required: Confirm Parcel`,
        `Your parcel ${shipment.shipmentId} has been delivered. Please inspect and confirm the parcel.`,
        'confirmed',
        shipment.shipmentId,
        'CONFIRM_PARCEL'
      );
    }

    res.json({
      message: 'Shipment marked as Delivered. Delivery confirmation notification dispatched to receiver.',
      shipment
    });
  } catch (error) {
    console.error('Simulate Delivered Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Toggle or enable return option for a shipment by supplier
 * @route   PUT /api/v1/shipments/:id/toggle-return
 * @access  Private
 */
const toggleReturnOption = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { returnAllowed } = req.body;
    const shipment = await Shipment.findOne({ shipmentId: id });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Verify sender
    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isSupplierAuth) {
      return res.status(403).json({ error: 'Only the seller/supplier can update return settings for this shipment' });
    }

    const newSetting = returnAllowed !== undefined ? Boolean(returnAllowed) : !shipment.returnAllowed;

    // Disallow disabling returns once payment link has been sent to receiver
    if (!newSetting && shipment.returnAllowed !== false) {
      if (shipment.paymentLink || shipment.paymentLinkSmsText || shipment.status !== 'Draft') {
        return res.status(400).json({ 
          error: 'Returns cannot be disabled after the payment link has been sent to the receiver.' 
        });
      }
    }

    shipment.returnAllowed = newSetting;
    if (newSetting) {
      shipment.returnOptionEnabledAt = new Date();
    }

    // Regenerate SMS text with updated policy
    const frontendBaseUrl = (process.env.FRONTEND_URL?.split(',')[0] || 'http://localhost:5173').trim();
    const smsRes = await smsService.sendPaymentLinkSms({
      phone: shipment.receiverPhone,
      shipmentId: shipment.shipmentId,
      amount: shipment.amount,
      description: shipment.description,
      carrierSlug: shipment.carrierSlug,
      linkUrl: shipment.paymentLink || `${frontendBaseUrl}/pay/${shipment.shipmentId}`,
      returnAllowed: newSetting
    });
    shipment.paymentLinkSmsText = smsRes.smsText;

    await shipment.save();

    // Add milestone in journey
    let journey = await CarrierJourney.findOne({ shipmentId: id });
    if (journey) {
      journey.milestones.push({
        status: newSetting ? 'Returns Enabled by Seller' : 'Returns Disabled by Seller',
        location: shipment.city || 'Origin Facility',
        detail: `Seller updated return policy: Product returns are now ${newSetting ? 'ENABLED (24h window upon delivery)' : 'DISABLED (Final Sale)'}.`,
        time: new Date()
      });
      await journey.save();
    }

    // Notify receiver
    const receiver = await findReceiverUser(shipment.receiverPhone);
    if (receiver) {
      await createNotification(
        receiver._id,
        newSetting ? 'verified' : 'info',
        `Return Policy Updated: ${shipment.shipmentId}`,
        `Seller ${newSetting ? 'has enabled 24-hour return protection' : 'has set this order to final sale (no returns)'} for parcel #${shipment.shipmentId}.`,
        'shipping',
        shipment.shipmentId
      );
    }

    res.json({
      message: `Return option successfully ${newSetting ? 'enabled' : 'disabled'} for shipment ${shipment.shipmentId}`,
      shipment,
      returnAllowed: shipment.returnAllowed,
      paymentLinkSmsText: shipment.paymentLinkSmsText
    });
  } catch (error) {
    console.error('Toggle Return Option Error:', error.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Get all return orders for the current supplier
 * @route   GET /api/v1/shipments/returns/supplier
 * @access  Private
 */
const getSupplierReturnOrders = async (req, res) => {
  try {
    const userIds = await getLinkedUserIds(req.user);
    const returnShipments = await Shipment.find({
      senderId: { $in: userIds },
      $or: [
        { returnStatus: { $in: ['Requested', 'Approved', 'In Return Transit', 'Returned & Refunded', 'Rejected'] } },
        { status: { $in: ['Return Requested', 'Return In Transit', 'Returned & Refunded'] } },
        { returnAwbCode: { $ne: '' } }
      ]
    })
      .select('-parcelPhoto -defectPhoto')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({
      success: true,
      count: returnShipments.length,
      returnOrders: returnShipments
    });
  } catch (error) {
    console.error('Get Supplier Return Orders Error:', error.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Get all return orders for logged-in receiver (buyer)
 * @route   GET /api/v1/shipments/returns/receiver
 * @access  Private
 */
const getReceiverReturnOrders = async (req, res) => {
  try {
    const userPhone = req.user.phone;
    const phoneList = [];
    if (userPhone && userPhone.trim()) {
      const raw = userPhone.trim();
      phoneList.push(raw);
      const digits = raw.replace(/\D/g, '');
      if (digits.length >= 10) {
        const ten = digits.slice(-10);
        phoneList.push(ten, `+91${ten}`, `91${ten}`, `+91 ${ten}`);
      }
    }
    const orConditions = [{ receiverId: req.user._id }];
    if (phoneList.length > 0) {
      orConditions.push({ receiverPhone: { $in: phoneList } });
    }

    const returnShipments = await Shipment.find({
      $or: orConditions,
      $and: [
        {
          $or: [
            { returnStatus: { $in: ['Requested', 'Approved', 'In Return Transit', 'Returned & Refunded', 'Rejected'] } },
            { status: { $in: ['Return Requested', 'Return In Transit', 'Returned & Refunded'] } },
            { returnRequested: true },
            { returnAwbCode: { $exists: true, $ne: '' } }
          ]
        }
      ]
    })
      .select('-parcelPhoto -defectPhoto')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({
      success: true,
      count: returnShipments.length,
      returnOrders: returnShipments
    });
  } catch (error) {
    console.error('Get Receiver Return Orders Error:', error.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Get supplier's monthly payment volume statistics
 * @route   GET /api/v1/shipments/gateway-fee-status
 * @access  Private
 */
const getSupplierGatewayQuota = async (req, res) => {
  try {
    const quota = await escrow.getSupplierMonthlyVolume(req.user._id);
    res.json(quota);
  } catch (error) {
    console.error('Get Gateway Quota Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Opt into photo review & pay ₹2 extra (called by receiver)
 * @route   POST /api/v1/shipments/:id/photo-review-pay
 * @access  Public / Private
 */
const optInPhotoReview = async (req, res) => {
  const id = req.params.id.toUpperCase();
  try {
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // IDOR Protection: Caller must be sender, receiver, or admin
    const userPhone = req.user?.phone;
    const isSender = await isAuthorizedSenderOrSupplier(req.user, shipment);
    const isReceiver = shipment.receiverPhone === userPhone ||
      (userPhone && shipment.receiverPhone && shipment.receiverPhone.replace(/\D/g, '').endsWith(userPhone.replace(/\D/g, '').slice(-10)));

    if (!isSender && !isReceiver && req.user?.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to modify photo review for this shipment' });
    }

    shipment.photoReviewEnabled = true;
    shipment.photoReviewRequested = true;
    shipment.photoReviewPaid = true;
    shipment.photoReviewRefused = false;
    await shipment.save();

    res.json({
      message: 'Parcel & product photo verification is mandatory for all shipments at no extra fee.',
      shipment
    });
  } catch (error) {
    console.error('Opt-in Photo Review Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Refuse / opt out of photo review (Deprecated: photo verification is mandatory for all shipments)
 * @route   POST /api/v1/shipments/:id/photo-review-refuse
 * @access  Private
 */
const refusePhotoReview = async (req, res) => {
  const id = req.params.id.toUpperCase();
  try {
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // IDOR Protection: Caller must be sender, receiver, or admin
    const userPhone = req.user?.phone;
    const isSender = await isAuthorizedSenderOrSupplier(req.user, shipment);
    const isReceiver = shipment.receiverPhone === userPhone ||
      (userPhone && shipment.receiverPhone && shipment.receiverPhone.replace(/\D/g, '').endsWith(userPhone.replace(/\D/g, '').slice(-10)));

    if (!isSender && !isReceiver && req.user?.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to modify photo review for this shipment' });
    }

    // Parcel photo verification is mandatory for all shipments on SecureKaro
    shipment.photoReviewEnabled = true;
    shipment.photoReviewRequested = true;
    shipment.photoReviewPaid = true;
    shipment.photoReviewRefused = false;
    await shipment.save();

    res.json({
      message: 'Parcel photo verification is mandatory for all shipments to guarantee delivery protection safety.',
      shipment,
      statusAdvanced: false
    });
  } catch (error) {
    console.error('Refuse Photo Review Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Upload parcel photo before dispatch (by Supplier)
 * @route   PUT /api/v1/shipments/:id/parcel-photo
 * @access  Private
 */
const uploadParcelPhoto = async (req, res) => {
  const id = req.params.id.toUpperCase();
  const { parcelPhotoUrl } = req.body;

  try {
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isSupplierAuth) {
      return res.status(403).json({ error: 'Only the supplier can upload parcel photos' });
    }

    if (!parcelPhotoUrl || !parcelPhotoUrl.trim()) {
      return res.status(400).json({ error: 'Please provide a parcel photo' });
    }

    const trimmedPhoto = parcelPhotoUrl.trim();
    const isHttpUrl = trimmedPhoto.startsWith('http://') || trimmedPhoto.startsWith('https://');
    const isDataUri = trimmedPhoto.startsWith('data:image/');

    if (!isHttpUrl && !isDataUri) {
      return res.status(400).json({ error: 'Product photo must be a valid image file or direct image URL.' });
    }

    if (isDataUri && trimmedPhoto.length < 50) {
      return res.status(400).json({ error: 'Product photo is invalid or unclear. Please take a clear, high-resolution photo of the product.' });
    }

    if (isHttpUrl && trimmedPhoto.length < 10) {
      return res.status(400).json({ error: 'Please provide a valid image URL.' });
    }

    if (shipment.parcelPhotoUploadedAt && shipment.parcelPhotoUrl) {
      const tenMinutes = 10 * 60 * 1000;
      const elapsed = Date.now() - new Date(shipment.parcelPhotoUploadedAt).getTime();
      if (elapsed > tenMinutes) {
        return res.status(400).json({ 
          error: 'The 10-minute retake window for parcel photo has expired. You can no longer change or retake this photo.' 
        });
      }
    }

    let finalPhotoUrl = trimmedPhoto;
    if (isDataUri) {
      try {
        const { uploadBase64ToR2 } = require('../services/r2Service');
        const uploadRes = await uploadBase64ToR2(trimmedPhoto, 'parcels');
        if (uploadRes && uploadRes.url) {
          finalPhotoUrl = uploadRes.url;
        }
      } catch (r2Err) {
        console.warn('[R2 AUTO-UPLOAD] Cloudflare R2 upload note:', r2Err.message);
      }
    }

    shipment.parcelPhotoUrl = finalPhotoUrl;
    shipment.parcelPhotoUploadedAt = shipment.parcelPhotoUploadedAt || new Date();

    // Generate unique In-Box QR Token & 6-digit Delivery OTP once parcel photo is uploaded
    if (!shipment.inboxQrToken) {
      const qrToken = crypto.randomBytes(20).toString('hex');
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      shipment.inboxQrToken = qrToken;
      shipment.inboxQrGeneratedAt = new Date();
      shipment.inboxQrUsed = false;
      shipment.deliveryOtp = otp;
      shipment.deliveryOtpExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      shipment.deliveryOtpUsed = false;
    }

    await shipment.save();

    res.json({
      message: 'Parcel photo uploaded successfully',
      shipment
    });
  } catch (error) {
    console.error('Upload Parcel Photo Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Supplier offers a partial discount amount on defective parcel return
 * @route   PUT /api/v1/shipments/:id/return-offer-discount
 * @access  Private (Supplier only)
 */
const offerDiscount = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { discountAmount } = req.body;
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) return res.status(404).json({ error: 'Shipment not found' });

    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isSupplierAuth && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the supplier can offer a discount' });
    }

    const result = await escrow.offerPartialDiscount(id, req.user._id, Number(discountAmount));
    res.json(result);
  } catch (error) {
    console.error('Offer Discount Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Buyer or Supplier accepts or rejects the partial discount offer
 * @route   PUT /api/v1/shipments/:id/return-respond-discount
 * @access  Private (Receiver or Supplier)
 */
const respondDiscount = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { accepted } = req.body;
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) return res.status(404).json({ error: 'Shipment not found' });

    // Strict IDOR protection: Must be the specific receiver of this shipment, authorized supplier, or Admin
    const isReceiver = isAuthorizedReceiver(req.user, shipment);
    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);

    if (!isReceiver && !isSupplierAuth && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Not authorized to respond to this discount offer. Only the recipient or seller of this shipment can take action.' });
    }

    // Determine if the action is performed from the seller side:
    // Only true if user is the authorized seller/sender and not the actual receiver
    const isSupplier = isSupplierAuth && !isReceiver;

    const result = await escrow.respondToDiscount(id, req.user._id, Boolean(accepted), isSupplier);
    res.json(result);
  } catch (error) {
    console.error('Respond Discount Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Supplier approves replacement request & assigns courier
 * @route   PUT /api/v1/shipments/:id/return-approve-replacement
 * @access  Private (Supplier only)
 */
const approveReplacementHandler = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) return res.status(404).json({ error: 'Shipment not found' });

    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isSupplierAuth) {
      return res.status(403).json({ error: 'Only the supplier can approve a replacement' });
    }

    const { carrierSlug, carrierName, trackingId } = req.body || {};
    const result = await escrow.approveReplacement(id, req.user._id, { carrierSlug, carrierName, trackingId });
    res.json(result);
  } catch (error) {
    console.error('Approve Replacement Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Supplier rejects replacement request -> triggers auto full refund
 * @route   PUT /api/v1/shipments/:id/return-reject-replacement
 * @access  Private (Supplier only)
 */
const rejectReplacementHandler = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const { reason } = req.body || {};
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) return res.status(404).json({ error: 'Shipment not found' });

    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isSupplierAuth) {
      return res.status(403).json({ error: 'Only the supplier can reject a replacement' });
    }

    const result = await escrow.rejectReplacement(id, req.user._id, reason || 'Replacement not possible');
    res.json(result);
  } catch (error) {
    console.error('Reject Replacement Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Supplier verifies old item received & dispatches new replacement item
 * @route   PUT /api/v1/shipments/:id/return-dispatch-replacement
 * @access  Private (Supplier only)
 */
const dispatchReplacementHandler = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) return res.status(404).json({ error: 'Shipment not found' });

    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isSupplierAuth && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the supplier can dispatch the replacement item' });
    }

    const { carrierSlug, carrierName, trackingId } = req.body || {};
    const result = await escrow.dispatchReplacement(id, req.user._id, { carrierSlug, carrierName, trackingId });
    res.json(result);
  } catch (error) {
    console.error('Dispatch Replacement Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Buyer confirms delivery of the replacement item
 * @route   PUT /api/v1/shipments/:id/return-confirm-replacement
 * @access  Private (Receiver only)
 */
const confirmReplacementDeliveryHandler = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) return res.status(404).json({ error: 'Shipment not found' });

    if (!isAuthorizedReceiver(req.user, shipment) && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the receiver can confirm replacement delivery' });
    }

    const result = await escrow.confirmReplacementDelivery(id, req.user._id);
    res.json(result);
  } catch (error) {
    console.error('Confirm Replacement Delivery Error:', error.message);
    res.status(400).json({ error: error.message });
  }
};

/**
 * @desc    Get QR label data for a shipment (seller/supplier only)
 * @route   GET /api/v1/shipments/:id/qr-label
 * @access  Private (sender only)
 */
const getQrLabel = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) return res.status(404).json({ error: 'Shipment not found' });
    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isSupplierAuth) {
      return res.status(403).json({ error: 'Only the seller can access this QR label' });
    }
    if (!shipment.parcelPhotoUrl || !shipment.parcelPhotoUrl.trim()) {
      return res.status(400).json({ 
        error: 'Parcel review photo is mandatory. Upload parcel photo first to generate and access the In-Box QR Code.' 
      });
    }

    if (!shipment.inboxQrToken) {
      const qrToken = crypto.randomBytes(20).toString('hex');
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      shipment.inboxQrToken = qrToken;
      shipment.inboxQrGeneratedAt = new Date();
      shipment.inboxQrUsed = false;
      shipment.deliveryOtpExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      shipment.deliveryOtpUsed = false;
      await shipment.save();
    }
    const frontendBase = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',')[0].trim() : 'http://localhost:3001';
    const qrUrl = `${frontendBase}/qr-confirm/${shipment.inboxQrToken}`;
    res.json({
      shipmentId: shipment.shipmentId,
      receiverName: shipment.receiverName,
      description: shipment.description,
      amount: shipment.amount,
      inboxQrToken: shipment.inboxQrToken,
      deliveryOtp: shipment.deliveryOtp,
      qrUrl,
      inboxQrUsed: shipment.inboxQrUsed,
      inboxQrConfirmedAt: shipment.inboxQrConfirmedAt,
      inboxQrGeneratedAt: shipment.inboxQrGeneratedAt
    });
  } catch (err) {
    console.error('Get QR Label Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Get replacement QR label data for a replacement shipment (seller/supplier only)
 * @route   GET /api/v1/shipments/:id/replacement-qr-label
 * @access  Private (sender only)
 */
const getReplacementQrLabel = async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const shipment = await Shipment.findOne({ shipmentId: id });
    if (!shipment) return res.status(404).json({ error: 'Shipment not found' });
    const isSupplierAuth = await isAuthorizedSenderOrSupplier(req.user, shipment);
    if (!isSupplierAuth && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the seller can access this replacement QR label' });
    }
    if (!shipment.replacementItemDispatched) {
      return res.status(400).json({ 
        error: 'Replacement item has not been dispatched yet. Dispatch replacement first to generate the label.' 
      });
    }

    if (!shipment.replacementQrToken) {
      const crypto = require('crypto');
      const repQrToken = crypto.randomBytes(20).toString('hex');
      const repOtp = String(Math.floor(100000 + Math.random() * 900000));
      shipment.replacementQrToken = repQrToken;
      shipment.replacementQrGeneratedAt = new Date();
      shipment.replacementQrUsed = false;
      shipment.replacementDeliveryOtp = repOtp;
      shipment.replacementDeliveryOtpExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      shipment.replacementDeliveryOtpUsed = false;
      await shipment.save();
    }
    const frontendBase = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',')[0].trim() : 'http://localhost:3001';
    const qrUrl = `${frontendBase}/qr-confirm/${shipment.replacementQrToken}`;
    res.json({
      shipmentId: shipment.shipmentId,
      receiverName: shipment.receiverName,
      description: shipment.description,
      amount: shipment.amount,
      isReplacement: true,
      replacementAwbCode: shipment.replacementAwbCode,
      replacementCarrierName: shipment.replacementCarrierName,
      replacementQrToken: shipment.replacementQrToken,
      replacementDeliveryOtp: shipment.replacementDeliveryOtp,
      qrUrl,
      replacementQrUsed: shipment.replacementQrUsed,
      replacementQrConfirmedAt: shipment.replacementQrConfirmedAt,
      replacementQrGeneratedAt: shipment.replacementQrGeneratedAt
    });
  } catch (err) {
    console.error('Get Replacement QR Label Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Public endpoint — receiver confirms delivery by scanning QR or entering OTP (NO login required)
 * @route   POST /api/v1/public/qr-confirm/:token
 * @access  Public
 */
// ── STEP 0: Public QR Info preview (masked phone hint, order details) ──────
const publicQrGetInfo = async (req, res) => {
  try {
    const token = req.params.token || req.query.qr || req.query.token;
    if (!token || token === 'undefined') {
      return res.status(400).json({ error: 'Invalid QR code token.' });
    }

    const shipment = await Shipment.findOne({
      $or: [
        { inboxQrToken: token },
        { replacementQrToken: token },
        { shipmentId: token }
      ]
    });
    if (!shipment) {
      return res.status(404).json({ error: 'QR code not found. This may be from an old or invalid shipment.' });
    }

    const isReplacement = token && shipment.replacementQrToken === token;

    const cleanStored = (shipment.receiverPhone || '').replace(/\D/g, '');
    const last4 = cleanStored.slice(-4);
    const maskedPhone = last4 ? `+91 ******${last4}` : 'Registered Phone';

    if (isReplacement) {
      return res.json({
        success: true,
        shipmentId: shipment.shipmentId,
        description: `[Replacement Parcel] ${shipment.description}`,
        amount: shipment.amount,
        isReplacement: true,
        replacementAwbCode: shipment.replacementAwbCode,
        replacementCarrierName: shipment.replacementCarrierName,
        returnAllowed: false,
        returnRequested: false,
        isReturnable: false,
        status: shipment.status,
        deliveryConfirmed: Boolean(shipment.replacementDelivered || shipment.status === 'Released'),
        deliveryConfirmedAt: shipment.replacementDeliveredAt || shipment.replacementQrConfirmedAt,
        inboxQrUsed: shipment.replacementQrUsed,
        inboxQrConfirmedAt: shipment.replacementQrConfirmedAt,
        receiverName: shipment.receiverName ? shipment.receiverName.split(' ')[0] : 'Receiver',
        maskedPhone,
        last4,
        cashbackEligible: false,
        cashbackPreview: null
      });
    }

    const isReturnable = shipment.returnAllowed !== false &&
      !shipment.returnWindowClosed &&
      (!shipment.returnWindowExpiresAt || new Date() < new Date(shipment.returnWindowExpiresAt)) &&
      !['Released', 'Cancelled', 'Returned & Refunded', 'Return Requested', 'Return In Transit'].includes(shipment.status);

    // Cashback window: 24 hours from delivery
    const deliveryTs = shipment.deliveredAt || shipment.deliveryConfirmedAt || shipment.inboxQrConfirmedAt;
    const cashbackWindowExpiresAt = deliveryTs
      ? new Date(new Date(deliveryTs).getTime() + 24 * 60 * 60 * 1000)
      : null;
    const cashbackWindowOpen = !shipment.inboxQrUsed &&
      !shipment.returnRequested &&
      (cashbackWindowExpiresAt ? new Date() < cashbackWindowExpiresAt : true);

    res.json({
      success: true,
      shipmentId: shipment.shipmentId,
      description: shipment.description,
      amount: shipment.amount,
      returnAllowed: shipment.returnAllowed,
      returnRequested: shipment.returnRequested,
      returnStatus: shipment.returnStatus,
      returnType: shipment.returnType,
      returnReason: shipment.returnReason,
      returnRequestedAt: shipment.returnRequestedAt,
      defectDescription: shipment.defectDescription,
      returnWindowExpiresAt: shipment.returnWindowExpiresAt,
      returnWindowClosed: shipment.returnWindowClosed,
      isReturnable,
      status: shipment.status,
      deliveryConfirmed: Boolean(shipment.deliveryConfirmed || shipment.status === 'Released'),
      deliveryConfirmedAt: shipment.deliveryConfirmedAt || shipment.inboxQrConfirmedAt,
      returnWindowChoice: shipment.returnWindowChoice,
      inboxQrUsed: shipment.inboxQrUsed,
      inboxQrConfirmedAt: shipment.inboxQrConfirmedAt,
      receiverName: shipment.receiverName ? shipment.receiverName.split(' ')[0] : 'Receiver',
      maskedPhone,
      last4,
      // Cashback metadata (shown as teaser — exact amount only revealed after confirm)
      cashbackEligible: cashbackWindowOpen,
      cashbackWindowExpiresAt,
      cashbackPreview: cashbackWindowOpen
        ? { minAmount: 3, maxAmount: 10, message: 'Confirm delivery to scratch & reveal your instant cashback!' }
        : null
    });
  } catch (err) {
    console.error('Public QR Get Info Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── STEP 1: Verify phone → send SMS OTP ────────────────────────────────────
const publicQrSendOtp = async (req, res) => {
  try {
    const token = req.params.token || req.query.qr || req.query.token;
    const { phone } = req.body;

    if (!token || token === 'undefined') {
      return res.status(400).json({ error: 'Invalid QR code token.' });
    }

    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Please provide your mobile number.' });
    }

    const shipment = await Shipment.findOne({
      $or: [
        { inboxQrToken: token },
        { replacementQrToken: token },
        { shipmentId: token }
      ]
    });
    if (!shipment) {
      return res.status(404).json({ error: 'QR code not found. This may be from an old or invalid shipment.' });
    }

    // ── Phone Identity Check ─────────────────────────────────────────────────
    const cleanInput = phone.replace(/\D/g, '');
    const cleanStored = (shipment.receiverPhone || '').replace(/\D/g, '');
    const fullMatch =
      cleanInput === cleanStored ||
      cleanInput === `91${cleanStored}` ||
      `91${cleanInput}` === cleanStored;
    const last4Match = cleanInput.length === 4 && cleanStored.endsWith(cleanInput);

    if (!fullMatch && !last4Match) {
      return res.status(403).json({
        error: 'Mobile number does not match the registered receiver for this order. Please check and try again.'
      });
    }

    const isReplacement = token && shipment.replacementQrToken === token;

    if (isReplacement) {
      if (shipment.replacementQrUsed || shipment.replacementDelivered) {
        return res.status(400).json({
          error: 'This replacement delivery has already been verified and confirmed.',
          alreadyConfirmed: true,
          confirmedAt: shipment.replacementQrConfirmedAt || shipment.replacementDeliveredAt
        });
      }
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      shipment.replacementDeliveryOtp = otp;
      shipment.replacementDeliveryOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
      shipment.replacementDeliveryOtpUsed = false;
      await shipment.save();

      const phoneForWa = cleanStored.length === 10 ? cleanStored : cleanInput;
      try {
        if (whatsappService && whatsappService.sendDeliveryOtpWhatsApp) {
          await whatsappService.sendDeliveryOtpWhatsApp({
            phone: phoneForWa,
            receiverName: shipment.receiverName,
            shipmentId: shipment.shipmentId,
            otp,
            isReplacement: true
          });
        }
      } catch (waErr) {
        console.warn('[Delivery OTP WhatsApp error]:', waErr.message);
      }

      return res.json({
        success: true,
        isReplacement: true,
        message: `Replacement delivery OTP sent to your WhatsApp on number ending in ${cleanStored.slice(-4)}. Valid for 10 minutes.`,
        shipment: {
          shipmentId: shipment.shipmentId,
          receiverName: shipment.receiverName,
          description: `[Replacement Parcel] ${shipment.description}`,
          amount: shipment.amount,
          isReplacement: true,
          status: shipment.status
        },
        ...(process.env.NODE_ENV !== 'production' && { _devOtp: otp })
      });
    }

    if (shipment.inboxQrUsed) {
      const isReturnable = shipment.returnAllowed !== false &&
        !shipment.returnWindowClosed &&
        (!shipment.returnWindowExpiresAt || new Date() < new Date(shipment.returnWindowExpiresAt)) &&
        !['Released', 'Cancelled', 'Returned & Refunded', 'Return Requested', 'Return In Transit'].includes(shipment.status);

      if (!isReturnable) {
        return res.status(400).json({
          error: 'This delivery has already been confirmed and the return window is closed.',
          alreadyConfirmed: true,
          confirmedAt: shipment.inboxQrConfirmedAt
        });
      }
    }

    // ── Generate & store OTP ─────────────────────────────────────────────────
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    shipment.deliveryOtp = otp;
    shipment.deliveryOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    shipment.deliveryOtpUsed = false;
    await shipment.save();

    // ── Send SMS ─────────────────────────────────────────────────────────────
    const phoneForWa = cleanStored.length === 10 ? cleanStored : cleanInput;
    try {
      if (whatsappService && whatsappService.sendDeliveryOtpWhatsApp) {
        await whatsappService.sendDeliveryOtpWhatsApp({
          phone: phoneForWa,
          receiverName: shipment.receiverName,
          shipmentId: shipment.shipmentId,
          otp,
          isReplacement: false
        });
      }
    } catch (waErr) {
      console.warn('[Delivery OTP WhatsApp error]:', waErr.message);
    }

    console.log(`[QR OTP] Sent OTP ${otp} to receiver of shipment ${shipment.shipmentId}`);

    const isReturnable = shipment.returnAllowed !== false &&
      !shipment.returnWindowClosed &&
      (!shipment.returnWindowExpiresAt || new Date() < new Date(shipment.returnWindowExpiresAt)) &&
      !['Released', 'Cancelled', 'Returned & Refunded', 'Return Requested', 'Return In Transit'].includes(shipment.status);

    res.json({
      success: true,
      message: `OTP sent to your registered mobile number ending in ${cleanStored.slice(-4)}. Valid for 10 minutes.`,
      shipment: {
        shipmentId: shipment.shipmentId,
        receiverName: shipment.receiverName,
        description: shipment.description,
        amount: shipment.amount,
        returnAllowed: shipment.returnAllowed,
        returnRequested: shipment.returnRequested,
        returnStatus: shipment.returnStatus,
        returnType: shipment.returnType,
        returnWindowExpiresAt: shipment.returnWindowExpiresAt,
        returnWindowClosed: shipment.returnWindowClosed,
        isReturnable,
        status: shipment.status
      },
      // In dev/demo mode expose OTP in response so it can be tested without SMS
      ...(process.env.NODE_ENV !== 'production' && { _devOtp: otp })
    });
  } catch (err) {
    console.error('Public QR Send OTP Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// ── STEP 2: Verify OTP + action: confirm or return ──────────────────────────
const publicQrConfirm = async (req, res) => {
  try {
    const token = req.params.token || req.query.qr || req.query.token;
    const {
      phone,
      otp,
      action,
      choice,
      reason,
      returnReason,
      returnType,
      comments,
      defectDescription,
      defectPhotoUrl,
      bankDetails
    } = req.body;

    if (!token || token === 'undefined') {
      return res.status(400).json({ error: 'Invalid QR code token.' });
    }
    if (!otp || otp.trim().length !== 6) {
      return res.status(400).json({ error: 'Please enter the 6-digit OTP sent to your phone.' });
    }

    const shipment = await Shipment.findOne({
      $or: [
        { inboxQrToken: token },
        { replacementQrToken: token },
        { shipmentId: token }
      ]
    });
    if (!shipment) {
      return res.status(404).json({ error: 'QR code not found. This may be from an old or invalid shipment.' });
    }

    const isReplacement = token && shipment.replacementQrToken === token;

    // ── Phone re-check (double verification) ────────────────────────────────
    if (phone) {
      const cleanInput = phone.replace(/\D/g, '');
      const cleanStored = (shipment.receiverPhone || '').replace(/\D/g, '');
      const fullMatch =
        cleanInput === cleanStored ||
        cleanInput === `91${cleanStored}` ||
        `91${cleanInput}` === cleanStored;
      const last4Match = cleanInput.length === 4 && cleanStored.endsWith(cleanInput);
      if (!fullMatch && !last4Match) {
        return res.status(403).json({ error: 'Phone number mismatch. Please use the same number you used to request the OTP.' });
      }
    }

    // ── REPLACEMENT PARCEL VERIFICATION FLOW ────────────────────────────────
    if (isReplacement) {
      if (shipment.replacementQrUsed || shipment.replacementDelivered || shipment.status === 'Released') {
        return res.status(400).json({
          error: 'This replacement parcel has already been verified and confirmed.',
          alreadyConfirmed: true,
          confirmedAt: shipment.replacementQrConfirmedAt || shipment.replacementDeliveredAt
        });
      }
      if (!shipment.replacementDeliveryOtp || shipment.replacementDeliveryOtp !== otp.trim()) {
        return res.status(400).json({ error: 'Incorrect replacement verification OTP. Please check the code sent to your phone.' });
      }
      if (shipment.replacementDeliveryOtpUsed) {
        return res.status(400).json({ error: 'This replacement OTP has already been used.' });
      }
      if (shipment.replacementDeliveryOtpExpiresAt && new Date() > shipment.replacementDeliveryOtpExpiresAt) {
        return res.status(400).json({ error: 'Replacement OTP has expired. Please request a new one.' });
      }

      shipment.replacementDeliveryOtpUsed = true;
      shipment.replacementQrUsed = true;
      shipment.replacementQrConfirmedAt = new Date();
      await shipment.save();

      // Release escrow to seller and complete the replacement order
      await escrow.confirmReplacementDelivery(shipment.shipmentId);

      return res.json({
        success: true,
        isReplacement: true,
        action: 'confirm',
        message: 'Replacement parcel delivery confirmed via In-Box QR & SMS OTP! Order funds released to the seller.',
        shipmentId: shipment.shipmentId,
        description: shipment.description
      });
    }

    // ── ORIGINAL PARCEL OTP Verification ────────────────────────────────────
    if (!shipment.deliveryOtp || shipment.deliveryOtp !== otp.trim()) {
      return res.status(400).json({ error: 'Incorrect OTP. Please check the code sent to your phone and try again.' });
    }
    if (shipment.deliveryOtpUsed) {
      return res.status(400).json({ error: 'This OTP has already been used.' });
    }
    if (shipment.deliveryOtpExpiresAt && new Date() > shipment.deliveryOtpExpiresAt) {
      return res.status(400).json({ error: 'OTP has expired. Please go back and request a new one.' });
    }

    // Mark OTP used regardless of action
    shipment.deliveryOtpUsed = true;

    // ── ACTION: Return Request ───────────────────────────────────────────────
    if (action === 'return') {
      if (shipment.returnRequested || shipment.status === 'Return Requested' || shipment.status === 'Return In Transit' || shipment.status === 'Returned & Refunded') {
        return res.status(400).json({
          error: 'A return request has already been applied for this parcel.',
          alreadyApplied: true,
          shipmentId: shipment.shipmentId,
          returnStatus: shipment.returnStatus || shipment.status
        });
      }
      if (shipment.returnAllowed === false) {
        return res.status(400).json({ error: 'Returns have not been enabled for this parcel by the seller.' });
      }
      if (shipment.returnWindowClosed) {
        return res.status(400).json({ error: 'The return window for this parcel is closed.' });
      }
      if (shipment.returnWindowExpiresAt && new Date() > new Date(shipment.returnWindowExpiresAt)) {
        return res.status(400).json({ error: 'The 24-hour return window has expired for this shipment.' });
      }

      const validTypes = ['full_refund', 'replacement', 'partial_discount'];
      const finalType = validTypes.includes(returnType) ? returnType : 'full_refund';
      const finalReason = returnReason || reason || 'Receiver requested return (verified via QR + OTP)';

      // Mandatory Photo Proof Check across all return types (full_refund, partial_discount, replacement)
      if (!defectPhotoUrl || typeof defectPhotoUrl !== 'string' || !defectPhotoUrl.trim()) {
        return res.status(400).json({
          error: 'Uploading photo proof of the package/item is mandatory for refund, partial return, and replacement requests.'
        });
      }

      shipment.returnRequested = true;
      shipment.returnRequestedAt = new Date();
      shipment.returnStatus = 'Requested';
      shipment.status = 'Return Requested';
      shipment.escrowStage = -4;
      shipment.returnReason = finalReason;
      shipment.returnType = finalType;

      if (defectPhotoUrl) {
        shipment.defectPhotoUrl = defectPhotoUrl;
      }
      if (comments || defectDescription) {
        shipment.defectDescription = comments || defectDescription;
      }

      if (bankDetails) {
        shipment.returnBankDetails = {
          accountHolderName: (bankDetails.accountHolderName || '').trim(),
          accountNumber: (bankDetails.accountNumber || '').trim(),
          ifscCode: (bankDetails.ifscCode || '').trim().toUpperCase(),
          bankName: (bankDetails.bankName || '').trim(),
          upiId: (bankDetails.upiId || '').trim()
        };
        try {
          const User = require('../models/User');
          const cleanPhone = (shipment.receiverPhone || phone || '').replace(/\D/g, '').slice(-10);
          const buyer = await User.findOne({ phone: new RegExp(cleanPhone + '$') });
          if (buyer) {
            if (!buyer.bankDetails) buyer.bankDetails = {};
            if (bankDetails.accountHolderName) buyer.bankDetails.accountHolderName = bankDetails.accountHolderName.trim();
            if (bankDetails.accountNumber) buyer.bankDetails.accountNumber = bankDetails.accountNumber.trim();
            if (bankDetails.ifscCode) buyer.bankDetails.ifscCode = bankDetails.ifscCode.trim().toUpperCase();
            if (bankDetails.bankName) buyer.bankDetails.bankName = bankDetails.bankName.trim();
            if (bankDetails.upiId) buyer.bankDetails.upiId = bankDetails.upiId.trim();
            await buyer.save();
          }
        } catch (bErr) {
          console.warn('[QR RETURN] Bank details save note:', bErr.message);
        }
      }

      shipment.inboxQrUsed = true;
      shipment.inboxQrConfirmedAt = new Date();
      shipment.inboxQrConfirmMethod = 'qr_scan_return';
      await shipment.save();

      const typeLabel = finalType === 'replacement' ? '🔄 Replacement' : finalType === 'partial_discount' ? '🏷️ Partial Discount' : '💰 Full Refund';

      // Update CarrierJourney milestone
      try {
        const CarrierJourney = require('../models/CarrierJourney');
        let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
        if (journey) {
          journey.milestones.push({
            status: 'Return Requested',
            location: 'Receiver Address',
            detail: `Receiver requested ${typeLabel} via in-box QR verification. Reason: ${finalReason}`,
            time: new Date()
          });
          await journey.save();
        }
      } catch (journeyErr) {
        console.warn('[QR RETURN] Journey update note:', journeyErr.message);
      }

      try {
        await createNotification(
          shipment.senderId,
          'swap_horizontal_circle',
          `Return Requested (${typeLabel}): ${shipment.shipmentId}`,
          `Receiver requested ${typeLabel} for "${shipment.description}" (Reason: ${finalReason}). Verified via in-box QR + SMS OTP. Please review in Return Orders.`,
          'return',
          shipment.shipmentId,
          'RETURN_ORDERS'
        );
      } catch (notifErr) {
        console.warn('[QR RETURN] Notification error:', notifErr.message);
      }

      return res.json({
        success: true,
        action: 'return',
        message: `Return request (${typeLabel}) submitted! The seller has been notified and will review your request.`,
        shipmentId: shipment.shipmentId,
        description: shipment.description,
        returnReason: finalReason,
        returnType: finalType
      });
    }

    // ── ACTION: Confirm Delivery ─────────────────────────────────────────────
    if (shipment.inboxQrUsed || shipment.deliveryConfirmed || shipment.status === 'Released') {
      const isClosed = shipment.returnWindowClosed || shipment.status === 'Released' || shipment.returnWindowChoice === 'ImmediateClose';
      const isExpired = shipment.returnWindowExpiresAt && new Date() >= new Date(shipment.returnWindowExpiresAt);
      const windowDetail = isClosed
        ? 'Return window is closed and order payment has been released.'
        : isExpired
          ? 'The 24-hour return window has expired.'
          : `24-hour return window is currently active until ${new Date(shipment.returnWindowExpiresAt).toLocaleString('en-IN')}.`;
      return res.status(400).json({
        error: `Parcel already confirmed. ${windowDetail}`,
        alreadyConfirmed: true,
        confirmedAt: shipment.inboxQrConfirmedAt || shipment.deliveryConfirmedAt,
        returnWindowClosed: isClosed,
        returnWindowExpiresAt: shipment.returnWindowExpiresAt
      });
    }

    const validStatuses = ['Out for Delivery', 'In Transit', 'Reached Destination Hub', 'Delivered'];
    if (!validStatuses.includes(shipment.status)) {
      return res.status(400).json({
        error: `Cannot confirm delivery — shipment is currently "${shipment.status}". Confirmation is only available once the parcel is out for delivery.`
      });
    }

    const confirmChoice = (choice === 'confirm_and_close' || choice === 'immediate' || shipment.returnAllowed === false)
      ? 'confirm_and_close'
      : 'keep_open_24h';

    shipment.inboxQrUsed = true;
    shipment.inboxQrConfirmedAt = new Date();
    shipment.inboxQrConfirmMethod = 'qr_scan';
    shipment.deliveryConfirmed = true;
    shipment.deliveryConfirmedAt = new Date();

    if (confirmChoice === 'confirm_and_close') {
      // Release escrow immediately to seller
      shipment.status = 'Released';
      shipment.escrowStage = 6;
      shipment.returnWindowClosed = true;
      shipment.returnClosedAt = new Date();
      shipment.returnWindowChoice = 'ImmediateClose';
      shipment.principalDisbursedToSupplier = shipment.amount;
      shipment.withdrawableAt = new Date();
    } else {
      // 24h return window
      shipment.status = 'Delivered';
      shipment.deliveredAt = new Date();
      shipment.escrowStage = 5;
      shipment.returnWindowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      shipment.returnWindowClosed = false;
      shipment.returnWindowChoice = 'KeepOpen24h';
    }

    await shipment.save();

    // Update CarrierJourney milestone
    try {
      const CarrierJourney = require('../models/CarrierJourney');
      let journey = await CarrierJourney.findOne({ shipmentId: shipment.shipmentId });
      if (journey) {
        journey.milestones.push({
          status: confirmChoice === 'confirm_and_close' ? 'Delivered & Confirmed (Payment Released)' : 'Delivered & Confirmed (24h Return Window Active)',
          location: 'Receiver Address',
          detail: confirmChoice === 'confirm_and_close'
            ? 'Receiver verified SMS OTP via QR sign-off and closed return window. Payment released to supplier.'
            : 'Receiver verified SMS OTP via QR sign-off. 24-hour return window is active.',
          time: new Date()
        });
        await journey.save();
      }
    } catch (journeyErr) {
      console.warn('[QR CONFIRM] Journey update note:', journeyErr.message);
    }

    try {
      await createNotification(
        shipment.senderId,
        'check_circle',
        `Delivery Confirmed: ${shipment.shipmentId}`,
        confirmChoice === 'confirm_and_close'
          ? `Receiver confirmed delivery of "${shipment.description}" via QR scan + SMS OTP. Payment released!`
          : `Receiver confirmed delivery of "${shipment.description}" via QR scan + SMS OTP. 24-hour return window is now active.`,
        'confirmed',
        shipment.shipmentId
      );
    } catch (notifErr) {
      console.warn('[QR CONFIRM] Notification error:', notifErr.message);
    }

    // ── Grant Delivery Confirmation Cashback (non-blocking) ──────────────────
    let cashbackResult = null;
    try {
      cashbackResult = await grantDeliveryConfirmCashback(
        shipment.shipmentId,
        shipment.receiverPhone
      );
      if (cashbackResult?.success) {
        console.log(`[QR CONFIRM] Cashback ₹${cashbackResult.amount} (${cashbackResult.tier}) granted for ${shipment.shipmentId}`);
      }
    } catch (cbErr) {
      console.warn('[QR CONFIRM] Cashback grant note (non-blocking):', cbErr.message);
    }

    res.json({
      success: true,
      action: 'confirm',
      choice: confirmChoice,
      message: confirmChoice === 'confirm_and_close'
        ? 'Delivery confirmed and return window closed! Payment released to the seller.'
        : 'Delivery confirmed! The seller has been notified and your 24-hour return window is now active.',
      shipmentId: shipment.shipmentId,
      receiverName: shipment.receiverName,
      description: shipment.description,
      amount: shipment.amount,
      confirmedAt: shipment.inboxQrConfirmedAt,
      confirmMethod: 'qr_scan',
      returnAllowed: shipment.returnAllowed,
      cashback: cashbackResult?.success ? {
        amount: cashbackResult.amount,
        tier: cashbackResult.tier,
        isLucky: cashbackResult.isLucky,
        isBonus: cashbackResult.isBonus,
        totalBalance: cashbackResult.totalCashbackBalance,
        minWithdrawal: cashbackResult.minWithdrawal,
        neededForWithdrawal: cashbackResult.neededForWithdrawal,
        message: cashbackResult.message
      } : null
    });
  } catch (err) {
    console.error('Public QR Confirm Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
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
      if (val instanceof Date) val = val.toISOString().split('T')[0];
      if (typeof val === 'object') val = JSON.stringify(val);
      val = String(val).replace(/"/g, '""');
      return `"${val}"`;
    }).join(',');
  });
  return [header, ...rows].join('\r\n');
};

/**
 * @desc    Export user's shipments as CA-ready Tax & P&L Statement (CSV or JSON)
 * @route   GET /api/v1/shipments/export
 * @access  Private
 */
const exportUserShipments = async (req, res) => {
  try {
    const userPhone = req.user.phone;
    const userIds = await getLinkedUserIds(req.user);
    const { format = 'csv', type = 'tax' } = req.query;

    const query = {
      $or: [
        { senderId: { $in: userIds } },
        ...(userPhone ? [{ receiverPhone: userPhone }] : [])
      ]
    };

    const shipments = await Shipment.find(query)
      .select('-parcelPhoto -defectPhoto')
      .populate('senderId', 'fullName email phone')
      .sort({ createdAt: -1 })
      .lean();

    if (format === 'csv') {
      const fields = [
        { label: 'Date', getter: s => s.createdAt ? new Date(s.createdAt).toLocaleDateString('en-IN') : '' },
        { label: 'Shipment / Invoice ID', key: 'shipmentId' },
        { label: 'Buyer Name', key: 'receiverName' },
        { label: 'Buyer Phone', key: 'receiverPhone' },
        { label: 'Destination City', key: 'city' },
        { label: 'Product Description', key: 'description' },
        { label: 'Gross Sale Value (INR)', getter: s => Number(s.amount || 0).toFixed(2) },
        { label: 'Payment Mode', key: 'paymentMode' },
        { label: 'Delivery Status', key: 'status' },
        { label: 'Fulfillment Stage', key: 'escrowStage' },
        { label: 'Courier Partner', key: 'carrierSlug' },
        { label: 'Carrier AWB Code', key: 'awbCode' },
        { label: 'Platform Gateway Fee (INR)', getter: s => Number(s.gatewayFeeDeducted || 0).toFixed(2) },
        { label: 'Estimated Tax / GST 18% (INR)', getter: s => (Number(s.amount || 0) * 0.18 / 1.18).toFixed(2) },
        { label: 'Taxable Turnover Base (INR)', getter: s => (Number(s.amount || 0) / 1.18).toFixed(2) },
        { label: 'Net Realized Revenue (INR)', getter: s => (s.status === 'Released' ? (Number(s.amount || 0) - Number(s.gatewayFeeDeducted || 0)).toFixed(2) : '0.00') },
        { label: 'RTO Protection Enabled', getter: s => s.rtoProtectionEnabled ? 'YES' : 'NO' },
        { label: 'RTO Return Status', key: 'returnStatus' },
        { label: 'RTO Compensation (INR)', getter: s => s.rtoCompensationClaimed ? '40.00' : '0.00' }
      ];

      const csv = convertToCSV(shipments, fields);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="securekaro_tax_pnl_statement_${Date.now()}.csv"`);
      return res.send(csv);
    }

    // JSON response
    const totalGross = shipments.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
    const totalReleased = shipments.filter(s => s.status === 'Released').reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
    const totalFees = shipments.reduce((sum, s) => sum + (Number(s.gatewayFeeDeducted) || 0), 0);
    const estTax = (totalGross * 0.18 / 1.18);
    const taxableBase = totalGross / 1.18;

    return res.json({
      success: true,
      summary: {
        totalOrders: shipments.length,
        grossSalesTurnover: totalGross,
        settledRevenue: totalReleased,
        platformFees: totalFees,
        taxableBase: Number(taxableBase.toFixed(2)),
        estimatedGst: Number(estTax.toFixed(2)),
        netRealizedProfit: totalReleased - totalFees
      },
      shipments
    });
  } catch (error) {
    console.error('Export User Shipments Error:', error);
    res.status(500).json({ error: 'Failed to export shipments data', details: error.message });
  }
};

module.exports = {
  getShipments,
  getShipmentById,
  createShipment,
  fundShipment,
  dispatchShipment,
  releaseShipment,
  cancelShipment,
  markUndelivered,
  requestReturn,
  approveReturn,
  confirmReturnReceived,
  generatePaymentLink,
  confirmDeliveryHandler,
  closeReturnRequestHandler,
  closeReturnWindowHandler,
  simulateDelivered,
  toggleReturnOption,
  getSupplierReturnOrders,
  getReceiverReturnOrders,
  getSupplierGatewayQuota,
  optInPhotoReview,
  refusePhotoReview,
  uploadParcelPhoto,
  offerDiscount,
  respondDiscount,
  approveReplacementHandler,
  rejectReplacementHandler,
  dispatchReplacementHandler,
  confirmReplacementDeliveryHandler,
  getQrLabel,
  getReplacementQrLabel,
  publicQrGetInfo,
  publicQrSendOtp,
  publicQrConfirm,
  exportUserShipments,
  quoteCodFees,
  executeOrderPaymentAndCourierBooking,
  publicPayShipment,
  paymentWebhookHandler
};

