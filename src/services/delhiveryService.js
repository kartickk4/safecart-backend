/**
 * Delhivery Direct B2C Logistics Service
 * =======================================
 * Direct integration with Delhivery Express Production API.
 * Provides live real-time rate calculation, waybill generation,
 * parcel manifest creation, and seller doorstep pickup scheduling.
 */

const axios = require('axios');

const DELHIVERY_API_KEY = process.env.DELHIVERY_API_KEY || '3e01738c62ef844146b08fffb95dd5e584bf36b7';
const DELHIVERY_ENV = process.env.DELHIVERY_ENV || 'PROD';
const BASE_URL = DELHIVERY_ENV === 'PROD' 
  ? 'https://track.delhivery.com' 
  : 'https://staging-express.delhivery.com';

const CLIENT_NAME = process.env.DELHIVERY_CLIENT_NAME || 'SECUREKARO';

/**
 * Fetch live shipping rates directly from Delhivery Invoice Charges API.
 * Applies the SecureKaro ₹2 seller rate offset.
 *
 * @param {Object} params
 * @param {string} params.fromPincode - Origin / Pickup pincode (6 digits)
 * @param {string} params.toPincode - Destination / Delivery pincode (6 digits)
 * @param {number} [params.weightKg=0.5] - Package weight in kilograms
 * @param {Object|null} [params.dimensions=null] - { length, width, height } in cm
 * @param {boolean} [params.isCod=false] - Whether Cash on Delivery
 * @param {number} [params.declaredValue=0] - Declared package value in INR
 * @param {boolean} [params.isSecureShipment=true] - Whether SecureKaro insurance active
 * @returns {Promise<Object|null>} Normalized carrier quote object or null
 */
const fetchDirectDelhiveryRate = async ({
  fromPincode,
  toPincode,
  weightKg = 0.5,
  dimensions = null,
  isCod = false,
  declaredValue = 0,
  isSecureShipment = true
}) => {
  if (!DELHIVERY_API_KEY) {
    console.warn('[Delhivery Direct] Missing DELHIVERY_API_KEY in environment');
    return null;
  }

  const cleanFrom = String(fromPincode || '').replace(/\D/g, '').slice(0, 6);
  const cleanTo = String(toPincode || '').replace(/\D/g, '').slice(0, 6);

  if (cleanFrom.length !== 6 || cleanTo.length !== 6) {
    return null;
  }

  // Calculate volumetric weight: (L * W * H) / 5000 in kg
  let effectiveKg = Math.max(0.1, parseFloat(weightKg) || 0.5);
  if (dimensions && dimensions.length && dimensions.width && dimensions.height) {
    const l = parseFloat(dimensions.length) || 0;
    const w = parseFloat(dimensions.width) || 0;
    const h = parseFloat(dimensions.height) || 0;
    if (l > 0 && w > 0 && h > 0) {
      const volumetricKg = (l * w * h) / 5000;
      effectiveKg = Math.max(effectiveKg, volumetricKg);
    }
  }

  const cgmGrams = Math.round(effectiveKg * 1000);

  try {
    const paymentType = isCod ? 'COD' : 'Pre-paid';
    const queryParams = new URLSearchParams({
      md: 'S', // Surface Express
      ss: 'Delivered',
      d_pin: cleanTo,
      o_pin: cleanFrom,
      cgm: String(cgmGrams),
      pt: paymentType
    });

    const res = await axios.get(`${BASE_URL}/api/kinko/v1/invoice/charges/?${queryParams.toString()}`, {
      headers: {
        'Authorization': `Token ${DELHIVERY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 7000
    });

    const chargesArray = Array.isArray(res.data) ? res.data : [];
    if (chargesArray.length === 0) {
      return null;
    }

    const data = chargesArray[0];
    const totalDelhiveryCost = parseFloat(data.total_amount) || parseFloat(data.gross_amount) || 0;
    if (totalDelhiveryCost <= 0) {
      return null;
    }

    // Apply platform ₹2 seller rate offset
    const discountedPrice = Math.max(35, parseFloat((totalDelhiveryCost - 2).toFixed(2)));
    const freightCharge = parseFloat((data.charge_DL || (totalDelhiveryCost * 0.75)).toFixed(2));
    const codCharge = isCod ? parseFloat((data.charge_COD || 54.00).toFixed(2)) : 0;
    const gstAmount = data.tax_data 
      ? parseFloat(((data.tax_data.SGST || 0) + (data.tax_data.CGST || 0) + (data.tax_data.IGST || 0)).toFixed(2))
      : parseFloat((totalDelhiveryCost * 0.18).toFixed(2));

    const weightSlabText = `${effectiveKg} K.G`;

    return {
      slug: 'delhivery_direct',
      baseSlug: 'delhivery',
      courierCompanyId: 'delhivery_direct_b2c',
      aggregator: 'delhivery_direct',
      aggregatorName: 'Delhivery Direct',
      courierPartner: `Delhivery Express (Direct B2C) ${weightSlabText}`,
      name: 'Delhivery Express',
      rawName: 'Delhivery Direct B2C Express',
      minWeightKg: effectiveKg,
      minWeightGrams: cgmGrams,
      weightSlab: weightSlabText,
      price: discountedPrice,
      exactRate: discountedPrice,
      originalRate: totalDelhiveryCost,
      discountOffset: 2.00,
      freightCharge,
      codCharge,
      gstAmount,
      whatsappCharge: 0,
      secureShipmentCharge: 0,
      isSecureShipment,
      isCod,
      eta: '1-2 Days (Priority Express)',
      rating: 4.8,
      mode: 'Surface Express',
      apiSource: 'Delhivery Direct Production B2C',
      zone: data.zone || 'Zone Domestic',
      serviceType: isCod ? 'Delhivery Direct COD' : 'Delhivery Direct Express',
      isDirectDelhivery: true
    };

  } catch (err) {
    console.warn('[Delhivery Direct Rate Error]:', err.response?.data || err.message);
    return null;
  }
};

/**
 * Checks pincode serviceability on Delhivery's live pin-code network
 * @param {string} pincode - 6-digit postal code
 * @returns {Promise<Object>} Serviceability details
 */
const checkDelhiveryServiceability = async (pincode) => {
  const cleanPin = String(pincode || '').replace(/\D/g, '').slice(0, 6);
  if (cleanPin.length !== 6) {
    return { serviceable: false, error: 'Invalid pincode format' };
  }

  try {
    const res = await axios.get(`${BASE_URL}/c/api/pin-codes/json/?filter_codes=${cleanPin}`, {
      headers: {
        'Authorization': `Token ${DELHIVERY_API_KEY}`
      },
      timeout: 5000
    });

    const deliveryCodes = res.data?.delivery_codes;
    if (Array.isArray(deliveryCodes) && deliveryCodes.length > 0) {
      const pinObj = deliveryCodes[0]?.postal_code;
      if (pinObj) {
        return {
          serviceable: true,
          pin: pinObj.pin,
          state: pinObj.state_code,
          codAllowed: pinObj.cod === 'Y',
          prepaidAllowed: pinObj.pre_paid === 'Y',
          pickupAllowed: pinObj.pickup === 'Y'
        };
      }
    }

    return { serviceable: false, error: 'Pincode not currently serviceable by Delhivery' };
  } catch (err) {
    console.warn(`[Delhivery Serviceability Error for ${cleanPin}]:`, err.message);
    return { serviceable: false, error: err.message };
  }
};

/**
 * Allocates a live official Delhivery tracking number (AWB / Waybill)
 * @param {number} [count=1] - Number of waybills to request
 * @returns {Promise<string|null>} Single allocated waybill code
 */
const generateDelhiveryWaybill = async (count = 1) => {
  try {
    const res = await axios.get(`${BASE_URL}/waybill/api/bulk/json/?count=${count}`, {
      headers: {
        'Authorization': `Token ${DELHIVERY_API_KEY}`
      },
      timeout: 6000
    });

    if (res.data) {
      const waybillStr = String(res.data).trim().split('\n')[0].replace(/["']/g, '');
      console.log(`✅ [Delhivery Direct] Allocated live waybill: ${waybillStr}`);
      return waybillStr;
    }
  } catch (err) {
    console.error('[Delhivery Waybill Allocation Error]:', err.response?.data || err.message);
  }
  return null;
};

/**
 * Manifests parcel directly on Delhivery CMU network.
 * Accurately routes pickup to the seller's doorstep.
 *
 * @param {Object} shipment - Mongoose Shipment document
 * @param {Object} senderUser - Mongoose User document for the seller
 * @returns {Promise<Object>} Booking confirmation with AWB and status
 */
const createDelhiveryDirectOrder = async (shipment, senderUser) => {
  if (!DELHIVERY_API_KEY) {
    throw new Error('DELHIVERY_API_KEY is not configured');
  }

  // 1. Allocate live waybill
  const waybill = await generateDelhiveryWaybill(1);
  if (!waybill) {
    throw new Error('Failed to allocate live waybill from Delhivery');
  }

  // 2. Format pickup (seller) and delivery (buyer) details
  const pickupPincode = String(shipment.senderPincode || senderUser?.pickupAddress?.pincode || senderUser?.pincode || '700049').replace(/\D/g, '').slice(0, 6);
  const pickupAddress = (shipment.senderAddress || senderUser?.pickupAddress?.street || senderUser?.address || 'Seller Doorstep').trim();
  const pickupName = (shipment.senderName || senderUser?.businessName || senderUser?.fullName || 'SecureKaro Seller').trim();
  const pickupPhone = String(shipment.senderPhone || senderUser?.phone || '9999999999').replace(/\D/g, '').slice(-10);

  const deliveryPincode = String(shipment.receiverPincode || '110001').replace(/\D/g, '').slice(0, 6);
  const deliveryAddress = (shipment.receiverAddress || 'Buyer Address').trim();
  const deliveryName = (shipment.receiverName || 'Buyer').trim();
  const deliveryPhone = String(shipment.receiverPhone || '9876543210').replace(/\D/g, '').slice(-10);

  const weightKg = parseFloat(shipment.weight || 0.5);
  const isCod = Boolean(shipment.paymentMethod === 'cod' || shipment.isCod);
  const totalAmount = parseFloat(shipment.escrowAmount || shipment.totalAmount || shipment.itemPrice || 0);

  const shipmentData = {
    shipments: [
      {
        name: deliveryName,
        add: deliveryAddress,
        pin: deliveryPincode,
        city: shipment.receiverCity || '',
        state: shipment.receiverState || '',
        country: 'India',
        phone: deliveryPhone,
        order: shipment.shipmentId || `ORD_${Date.now()}`,
        payment_mode: isCod ? 'COD' : 'Pre-paid',
        return_pin: pickupPincode,
        return_city: shipment.senderCity || '',
        return_phone: pickupPhone,
        return_add: pickupAddress,
        return_state: shipment.senderState || '',
        return_country: 'India',
        products_desc: shipment.itemDescription || 'Consumer Merchandise',
        hsn_code: '',
        cod_amount: isCod ? String(totalAmount) : '0',
        order_date: new Date().toISOString().slice(0, 19).replace('T', ' '),
        total_amount: String(totalAmount),
        seller_add: pickupAddress,
        seller_name: pickupName,
        seller_inv: shipment.shipmentId || '',
        quantity: String(shipment.quantity || 1),
        waybill,
        shipment_width: shipment.dimensions?.width ? String(shipment.dimensions.width) : '10',
        shipment_height: shipment.dimensions?.height ? String(shipment.dimensions.height) : '10',
        weight: String(Math.round(weightKg * 1000))
      }
    ],
    pickup_location: {
      name: pickupName,
      add: pickupAddress,
      city: shipment.senderCity || '',
      pin_code: pickupPincode,
      country: 'India',
      phone: pickupPhone
    }
  };

  try {
    const postData = `format=json&data=${encodeURIComponent(JSON.stringify(shipmentData))}`;

    const res = await axios.post(`${BASE_URL}/api/cmu/create.json`, postData, {
      headers: {
        'Authorization': `Token ${DELHIVERY_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 12000
    });

    console.log(`✅ [Delhivery Direct Manifest]: Created order for ${shipment.shipmentId}. Response:`, JSON.stringify(res.data).slice(0, 200));

    return {
      success: true,
      awbCode: waybill,
      carrierSlug: 'delhivery',
      courierName: 'Delhivery Express (Direct)',
      bookingRef: waybill,
      status: 'BOOKED',
      labelUrl: `https://track.delhivery.com/api/p/packing_slip?wbns=${waybill}&pdf=true`,
      data: res.data
    };

  } catch (err) {
    console.error('[Delhivery Direct Manifest Error]:', err.response?.data || err.message);
    throw new Error(`Delhivery booking failed: ${err.response?.data?.error || err.message}`);
  }
};

module.exports = {
  fetchDirectDelhiveryRate,
  checkDelhiveryServiceability,
  generateDelhiveryWaybill,
  createDelhiveryDirectOrder
};
