const Shipment = require('../models/Shipment');
const CarrierJourney = require('../models/CarrierJourney');
const User = require('../models/User');
const { createNotification } = require('../services/notification');
const { cacheManager } = require('../services/cacheManager');
const axios = require('axios');


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
 * @desc    Get tracking journey details by AWB code or Shipment ID
 * @route   GET /api/v1/tracking/:awb
 * @access  Public
 *
 * Implements:
 * 1. PII Sanitization: Never exposes customer phone, address, or payment details publicly.
 * 2. Safe 3-Minute caching for public tracking milestones.
 * 3. Cache stampede protection.
 */
const getTrackingByAwb = async (req, res) => {
  const { awb } = req.params;
  const cleanAwb = String(awb || '').trim().toUpperCase();

  try {
    const cacheKey = cacheManager.generateKey('tracking:milestones', { awb: cleanAwb });
    const isCached = cacheManager.memoryStore.has(cacheKey);

    const trackingData = await cacheManager.getOrSet(cacheKey, async () => {
      const shipment = await Shipment.findOne({
        $or: [{ awbCode: cleanAwb }, { shipmentId: cleanAwb }]
      }).select('shipmentId awbCode carrierSlug carrierName status city createdAt');

      const journey = await CarrierJourney.findOne({
        $or: [{ awbCode: cleanAwb }, { shipmentId: cleanAwb }]
      });

      if (!shipment && !journey) {
        return null;
      }

      // Safe Public Tracking Payload (Zero PII, no personal contact numbers, no payment secrets)
      return {
        awb: cleanAwb,
        shipmentId: shipment ? shipment.shipmentId : (journey ? journey.shipmentId : null),
        status: shipment ? shipment.status : (journey ? journey.courierName : 'In Transit'),
        courierName: (journey && journey.courierName) || (shipment && shipment.carrierName) || 'Carrier Partner',
        carrierSlug: shipment ? shipment.carrierSlug : 'delhivery',
        route: shipment?.city || 'Inter-city Transit',
        milestones: journey ? journey.milestones : [],
        lastUpdated: new Date().toISOString()
      };
    }, 180, { tags: [`tracking:${cleanAwb}`, 'tracking:public'] });

    if (!trackingData) {
      return res.status(404).json({ error: 'Tracking info not found for provided AWB or Shipment ID' });
    }

    res.setHeader('X-Cache', isCached ? 'HIT' : 'MISS');
    res.setHeader('X-Cache-Key', cacheKey);
    res.setHeader('Cache-Control', 'public, max-age=180');
    res.json(trackingData);
  } catch (error) {
    console.error('Get Tracking Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Receive simulated tracking webhook updates
 * @route   POST /api/v1/tracking/webhook/carrier-tracking
 * @access  Public
 */
const handleWebhook = async (req, res) => {
  const { awb, status, current_status, location, activities } = req.body;

  const awbCode = awb || req.body.awbCode;
  const trackingStatus = status || current_status || 'In Transit';

  try {
    if (!awbCode) {
      return res.status(400).json({ error: 'Awb/tracking code is required in webhook body' });
    }

    const shipment = await Shipment.findOne({ awbCode });
    if (!shipment) {
      console.warn(`[TRACKING WEBHOOK] Received update for untracked AWB: ${awbCode}`);
      return res.status(404).json({ error: 'Associated shipment not found' });
    }

    // Update CarrierJourney milestones
    let journey = await CarrierJourney.findOne({ awbCode });
    if (!journey) {
      journey = new CarrierJourney({
        shipmentId: shipment.shipmentId,
        awbCode,
        courierName: shipment.carrierSlug ? shipment.carrierSlug.toUpperCase() : "Carrier Partner",
        milestones: []
      });
    }

    if (activities && Array.isArray(activities)) {
      journey.milestones = activities.map(act => ({
        status: act.status || act.activity,
        location: act.location || 'Hub',
        detail: act.activity || act.detail || `Status: ${act.status}`,
        time: act.date ? new Date(act.date) : (act.time ? new Date(act.time) : new Date())
      }));
    } else {
      journey.milestones.push({
        status: trackingStatus,
        location: location || 'Sorting Facility',
        detail: `Status updated via webhook to: ${trackingStatus}`,
        time: new Date()
      });
    }
    await journey.save();

    // Map status string to escrow stages
    let newStatus = shipment.status;
    let newStage = shipment.escrowStage;

    const statusStr = trackingStatus.toLowerCase();
    if (statusStr.includes('delivered')) {
      newStatus = 'Delivered';
      newStage = 5;
    } else if (statusStr.includes('out for delivery')) {
      newStatus = 'Out for Delivery';
      newStage = 4;
    } else if (statusStr.includes('transit') || statusStr.includes('picked') || statusStr.includes('shipped')) {
      newStatus = 'In Transit';
      newStage = 4;
    } else if (statusStr.includes('pending')) {
      newStatus = 'Pending Pickup';
      newStage = 3;
    }

    if (newStatus !== shipment.status || newStage !== shipment.escrowStage) {
      shipment.status = newStatus;
      shipment.escrowStage = newStage;
      await shipment.save();

      console.log(`[TRACKING WEBHOOK] Shipment ${shipment.shipmentId} updated to: ${newStatus}`);

      await createNotification(
        shipment.senderId,
        'local_shipping',
        `Logistics Update: ${newStatus} — ${shipment.shipmentId}`,
        `Your shipment status is: ${newStatus}. Location: ${location || 'Hub'}.`,
        'shipping'
      );

      const receiver = await findReceiverUser(shipment.receiverPhone);
      if (receiver) {
        await createNotification(
          receiver._id,
          'local_shipping',
          `Logistics Update: ${newStatus} — ${shipment.shipmentId}`,
          `Your shipment status is: ${newStatus}. Location: ${location || 'Hub'}.`,
          'shipping'
        );

        if (newStage === 5 || newStatus === 'Delivered') {
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
      }
    }

    // Instantly invalidate tracking milestones cache for this AWB and refresh admin summaries
    await cacheManager.invalidateTag(`tracking:${awbCode}`);
    await cacheManager.invalidateTag('admin:analytics');
    await cacheManager.invalidatePattern(`tracking:milestones:*${awbCode}*`);

    res.json({ message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Public parcel tracking with phone number verification (no login required)
 * @route   POST /api/v1/tracking/public or GET /api/v1/tracking/public
 * @access  Public
 */
const getPublicTracking = async (req, res) => {
  const trackingId = (req.body?.trackingId || req.query?.trackingId || req.body?.shipmentId || req.query?.shipmentId || req.body?.awb || req.query?.awb || '').trim();
  const phone = (req.body?.phone || req.query?.phone || '').trim();

  if (!trackingId) {
    return res.status(400).json({ error: 'Shipment ID or AWB Tracking code is required.' });
  }

  if (!phone) {
    return res.status(400).json({ error: 'Registered mobile number is required to verify ownership.' });
  }

  try {
    // 1. Find shipment
    const shipment = await Shipment.findOne({
      $or: [
        { shipmentId: new RegExp(`^${trackingId}$`, 'i') },
        { awbCode: new RegExp(`^${trackingId}$`, 'i') }
      ]
    }).populate('senderId', 'fullName businessName phone email address');

    if (!shipment) {
      return res.status(404).json({
        error: `No parcel found matching "${trackingId}". Please check your Shipment ID or AWB code.`
      });
    }

    // 2. Verify Phone Number (Receiver phone or Sender phone)
    const cleanPhone = phone.replace(/\D/g, '');
    const receiverDigits = (shipment.receiverPhone || '').replace(/\D/g, '');
    const senderDigits = (shipment.senderId?.phone || '').replace(/\D/g, '');

    const isReceiverMatch = cleanPhone.length >= 4 && (
      receiverDigits.endsWith(cleanPhone) ||
      cleanPhone.endsWith(receiverDigits.slice(-10)) ||
      receiverDigits === cleanPhone
    );

    const isSenderMatch = cleanPhone.length >= 4 && (
      senderDigits.endsWith(cleanPhone) ||
      cleanPhone.endsWith(senderDigits.slice(-10)) ||
      senderDigits === cleanPhone
    );

    if (!isReceiverMatch && !isSenderMatch) {
      return res.status(403).json({
        error: 'Phone verification failed. The provided phone number does not match this parcel. Please enter the buyer or seller mobile number associated with this order.'
      });
    }

    // 3. Fetch carrier journey
    const journey = await CarrierJourney.findOne({
      $or: [
        { shipmentId: shipment.shipmentId },
        { awbCode: shipment.awbCode || trackingId }
      ]
    });

    // 4. Generate Live Telemetry
    let telemetry = null;
    try {
      telemetry = getLiveTelemetry(
        shipment.carrierSlug || 'delhivery',
        shipment.awbCode || shipment.shipmentId,
        shipment
      );
    } catch (e) {
      console.warn('Telemetry generation note:', e.message);
    }

    // Mask sensitive details
    const maskPhoneNum = (ph) => {
      if (!ph) return '';
      const digits = ph.replace(/\D/g, '');
      if (digits.length >= 10) {
        return `+91 ******${digits.slice(-4)}`;
      }
      return '******' + digits.slice(-2);
    };

    const maskFullName = (name) => {
      if (!name) return 'Customer';
      const parts = name.trim().split(' ');
      if (parts.length > 1) {
        return `${parts[0]} ${parts[1][0]}.`;
      }
      return parts[0];
    };

    const stageMap = {
      1: { label: 'Order Created', desc: 'Order initialized, awaiting escrow deposit.' },
      2: { label: 'Secured in Escrow Vault', desc: 'Buyer funds safely locked in SecureKaro escrow vault.' },
      3: { label: 'Packed & Ready for Pickup', desc: 'Seller has packaged parcel and scheduled courier pickup.' },
      4: { label: 'In Transit', desc: 'Courier is transporting parcel to destination.' },
      5: { label: 'Delivered', desc: 'Parcel reached destination. Awaiting buyer inspection.' },
      6: { label: 'Inspection / Confirmed', desc: 'Delivery confirmed, funds settling to seller.' },
      7: { label: 'Escrow Completed', desc: 'Transaction completed safely.' }
    };

    const currentStageInfo = stageMap[shipment.escrowStage] || {
      label: shipment.status || 'Active',
      desc: 'Shipment managed under SecureKaro Escrow Protection.'
    };

    const publicData = {
      shipmentId: shipment.shipmentId,
      awbCode: shipment.awbCode || 'Pending Assignment',
      carrierSlug: shipment.carrierSlug || 'delhivery',
      courierName: shipment.carrierSlug ? shipment.carrierSlug.toUpperCase() : 'Carrier Partner',
      status: shipment.status,
      escrowStage: shipment.escrowStage,
      stageLabel: currentStageInfo.label,
      stageDesc: currentStageInfo.desc,
      amount: shipment.amount,
      description: shipment.description,
      city: shipment.city,
      pickupCarrier: shipment.pickupCarrier || (shipment.carrierSlug ? shipment.carrierSlug.toUpperCase() : 'Delhivery / Shiprocket'),
      pickupSlot: shipment.pickupSlot || '',
      pickupStatus: shipment.pickupStatus || 'Scheduled',
      receiverName: maskFullName(shipment.receiverName),
      receiverPhoneMasked: maskPhoneNum(shipment.receiverPhone),
      senderBusinessName: shipment.senderId?.businessName || shipment.senderId?.fullName || 'Verified Merchant',
      senderCity: shipment.senderId?.address?.city || '',
      parcelPhotoUrl: shipment.parcelPhotoUrl || '',
      photoReviewPaid: Boolean(shipment.photoReviewPaid),
      photoReviewRequested: Boolean(shipment.photoReviewRequested),
      returnAllowed: shipment.returnAllowed,
      returnStatus: shipment.returnStatus,
      createdAt: shipment.createdAt,
      updatedAt: shipment.updatedAt,
      estimatedDeliveryDate: shipment.estimatedDeliveryDate || new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
    };

    const milestones = journey && journey.milestones && journey.milestones.length > 0
      ? journey.milestones
      : [
          {
            status: shipment.status || 'In Transit',
            location: shipment.city || 'Regional Logistics Hub',
            detail: `Parcel status is currently ${shipment.status || 'In Transit'}. Funds safely held in Escrow.`,
            time: shipment.updatedAt || shipment.createdAt || new Date()
          }
        ];

    return res.json({
      success: true,
      shipment: publicData,
      journey: milestones,
      telemetry: telemetry || null
    });
  } catch (error) {
    console.error('Public Tracking Error:', error);
    return res.status(500).json({ error: 'Failed to retrieve tracking details. Please try again.' });
  }
};

/**
 * @desc    Poll Shiprocket for live delivery status by AWB
 * @route   GET /api/v1/tracking/shiprocket-status/:awb
 * @access  Private
 */
const getShiprocketDeliveryStatus = async (req, res) => {
  const { awb } = req.params;

  try {
    const shipment = await Shipment.findOne({
      $or: [{ awbCode: awb }, { shipmentId: awb }]
    });

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found.' });
    }

    const trackAwb = shipment.awbCode || awb;
    let newStatus = shipment.status;
    let newStage = shipment.escrowStage;
    let shiprocketRaw = null;

    // --- Attempt to fetch from Shiprocket API ---
    const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
    const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;
    const SHIPROCKET_TOKEN = process.env.SHIPROCKET_TOKEN; // pre-configured token

    let authToken = SHIPROCKET_TOKEN || null;

    if (!authToken && SHIPROCKET_EMAIL && SHIPROCKET_PASSWORD) {
      try {
        const authRes = await axios.post('https://apiv2.shiprocket.in/v1/external/auth/login', {
          email: SHIPROCKET_EMAIL,
          password: SHIPROCKET_PASSWORD
        }, { timeout: 8000 });
        authToken = authRes.data?.token;
      } catch (authErr) {
        console.warn('[SHIPROCKET] Auth failed:', authErr.message);
      }
    }

    if (authToken && trackAwb && trackAwb !== 'N/A') {
      try {
        const srRes = await axios.get(
          `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${trackAwb}`,
          {
            headers: { Authorization: `Bearer ${authToken}` },
            timeout: 8000
          }
        );
        const srData = srRes.data?.tracking_data;
        shiprocketRaw = srData || null;

        const currentStatus = (
          srData?.shipment_status_id ||
          srData?.current_status ||
          srData?.awb_assign_status ||
          ''
        ).toString().toLowerCase();

        const srStatus = srData?.current_status || '';

        if (currentStatus.includes('delivered') || srStatus.toLowerCase().includes('delivered')) {
          newStatus = 'Delivered';
          newStage = 5;
        } else if (
          currentStatus.includes('out for delivery') ||
          srStatus.toLowerCase().includes('out for delivery')
        ) {
          newStatus = 'Out for Delivery';
          newStage = 4;
        } else if (
          currentStatus.includes('transit') ||
          currentStatus.includes('picked') ||
          currentStatus.includes('shipped')
        ) {
          newStatus = 'In Transit';
          newStage = 4;
        }

        // Save updated status to DB if changed
        if (newStatus !== shipment.status || newStage !== shipment.escrowStage) {
          shipment.status = newStatus;
          shipment.escrowStage = newStage;
          await shipment.save();
          console.log(`[SHIPROCKET POLL] ${shipment.shipmentId} updated to: ${newStatus}`);

          if (newStatus === 'Delivered') {
            const receiver = await findReceiverUser(shipment.receiverPhone);
            if (receiver) {
              await createNotification(
                receiver._id,
                'inventory_2',
                `Parcel Delivered — Action Required: Confirm Parcel`,
                `Your parcel ${shipment.shipmentId} has been delivered. Please inspect and confirm the parcel within 24 hours.`,
                'confirmed',
                shipment.shipmentId,
                'CONFIRM_PARCEL'
              );
            }
          }
        }
      } catch (srErr) {
        console.warn('[SHIPROCKET] Status fetch failed:', srErr.message);
        // Non-fatal: return current DB status
      }
    }

    return res.json({
      success: true,
      shipmentId: shipment.shipmentId,
      awbCode: shipment.awbCode,
      status: newStatus,
      escrowStage: newStage,
      shiprocketData: shiprocketRaw
    });
  } catch (error) {
    console.error('[SHIPROCKET POLL] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch delivery status.' });
  }
};

module.exports = {
  getTrackingByAwb,
  handleWebhook,
  getPublicTracking,
  getShiprocketDeliveryStatus
};
