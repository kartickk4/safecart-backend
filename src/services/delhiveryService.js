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
 * Applies the SecureKaro ₹5 seller rate offset.
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

    if (isCod) {
      const codVal = parseFloat(declaredValue) || 0;
      if (codVal > 0) {
        queryParams.set('cod', String(codVal));
      }
    }

    const res = await axios.get(`${BASE_URL}/api/kinko/v1/invoice/charges/?${queryParams.toString()}`, {
      headers: {
        'Authorization': `Token ${DELHIVERY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
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

    // Apply platform ₹5 discount directly on freight charge
    const rawFreight = parseFloat((data.charge_DL || 0).toFixed(2));
    const discountedFreight = Math.max(10, parseFloat((rawFreight - 5.00).toFixed(2)));
    const discountedPrice = Math.max(30, parseFloat((totalDelhiveryCost - 5).toFixed(2)));
    const codCharge = isCod ? parseFloat((data.charge_COD || 0).toFixed(2)) : 0;
    const lmSurcharge = parseFloat((data.charge_LM || 0).toFixed(2));
    const peakSurcharge = parseFloat((data.charge_PEAK || 0).toFixed(2));
    const dieselCharge = parseFloat((data.charge_DPH || 0).toFixed(2));
    const totalSurcharges = parseFloat((lmSurcharge + peakSurcharge + dieselCharge).toFixed(2));

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
      originalFreight: rawFreight,
      discountOffset: 5.00,
      freightCharge: discountedFreight,
      codCharge,
      surcharges: totalSurcharges,
      gstAmount,
      breakdown: {
        rawFreight: rawFreight,
        discountedFreight: discountedFreight,
        discount: 5.00,
        lastMile: lmSurcharge,
        fuelSurcharge: dieselCharge,
        peakSurcharge: peakSurcharge,
        codCharge: codCharge,
        gstAmount: gstAmount,
        totalWithoutDiscount: totalDelhiveryCost,
        finalPrice: discountedPrice
      },
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
      timeout: 15000
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

const registeredWarehouses = new Set();

/**
 * Ensures the seller's doorstep pickup location is registered as a Client Warehouse in Delhivery HQ.
 * Allows Delhivery delivery executives to navigate directly to the seller's house/shop anywhere in India.
 *
 * @param {Object} senderUser - Mongoose User document for the seller
 * @param {Object} shipment - Mongoose Shipment document
 * @returns {Promise<string>} Registered Delhivery warehouse nickname
 */
const ensureDelhiveryWarehouse = async (senderUser, shipment) => {
  if (!DELHIVERY_API_KEY) return 'SECUREKARO_HQ';

  const sellerPincode = String(
    shipment.senderPincode ||
    senderUser?.pickupAddress?.pincode ||
    senderUser?.pincode ||
    '700049'
  ).replace(/\D/g, '').slice(0, 6);

  const sellerIdSnippet = String(senderUser?._id || shipment?.senderId?._id || shipment?.senderId || 'SELLER').slice(-6).toUpperCase();
  const warehouseName = `PKP_${sellerPincode}_${sellerIdSnippet}`;

  if (registeredWarehouses.has(warehouseName)) {
    return warehouseName;
  }

  let sellerAddress = (
    shipment.senderAddress ||
    senderUser?.pickupAddress?.street ||
    senderUser?.address ||
    'Seller Doorstep Warehouse'
  ).trim();

  if (sellerAddress.length < 10) {
    sellerAddress = `${sellerAddress}, Doorstep Location`;
  }

  const sellerPhone = String(shipment.senderPhone || senderUser?.phone || '9999999999').replace(/\D/g, '').slice(-10);
  const sellerEmail = senderUser?.email || `${sellerPhone}@securekaro.in`;
  const sellerCity = shipment.senderCity || senderUser?.pickupAddress?.city || senderUser?.city || 'City';
  const sellerState = shipment.senderState || senderUser?.pickupAddress?.state || senderUser?.state || 'State';
  const sellerRegisteredName = (senderUser?.businessName || senderUser?.fullName || 'SecureKaro Merchant').trim();

  try {
    const res = await axios.post(`${BASE_URL}/api/backend/clientwarehouse/create/`, {
      name: warehouseName,
      registered_name: sellerRegisteredName,
      email: sellerEmail,
      phone: sellerPhone,
      address: sellerAddress,
      city: sellerCity,
      state: sellerState,
      country: 'India',
      pin: sellerPincode,
      return_address: sellerAddress,
      return_pin: sellerPincode,
      return_city: sellerCity,
      return_state: sellerState,
      return_country: 'India'
    }, {
      headers: {
        'Authorization': `Token ${DELHIVERY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 8000
    });
    registeredWarehouses.add(warehouseName);
    console.log(`✅ [Delhivery Warehouse]: Registered seller pickup warehouse in Delhivery HQ: ${warehouseName} (${sellerAddress}, Pin: ${sellerPincode})`);
    return warehouseName;
  } catch (err) {
    // If warehouse already exists, Delhivery returns 400 with 'already exists' - reuse it
    registeredWarehouses.add(warehouseName);
    return warehouseName;
  }
};

/**
 * Dispatches a First Mile Pickup Request to Delhivery HQ.
 * Automatically schedules courier arrival at the seller doorstep and transitions status from "Ready to ship" to "Pickup scheduled".
 *
 * @param {string} warehouseName - Registered client warehouse name
 * @param {string} pickupDateStr - Date in YYYY-MM-DD
 * @param {string} pickupTimeStr - Time in HH:MM:SS (e.g. '11:00:00' or '14:00:00')
 * @param {number} [packageCount=1] - Number of packages to be picked up
 * @returns {Promise<Object>}
 */
const requestDelhiveryPickup = async (warehouseName, pickupDateStr, pickupTimeStr = '14:00:00', packageCount = 1) => {
  if (!DELHIVERY_API_KEY) {
    return { success: false, error: 'DELHIVERY_API_KEY missing' };
  }

  try {
    const payload = {
      pickup_location: warehouseName,
      expected_package_count: packageCount || 1,
      pickup_date: pickupDateStr,
      pickup_time: pickupTimeStr
    };

    console.log(`[Delhivery Live Pickup Request] Dispatching to /fm/request/new/:`, JSON.stringify(payload));
    const res = await axios.post(`${BASE_URL}/fm/request/new/`, payload, {
      headers: {
        'Authorization': `Token ${DELHIVERY_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    console.log(`✅ [Delhivery Pickup Request Created]:`, JSON.stringify(res.data));
    const prId = res.data?.pr_id || res.data?.pickup_id || res.data?.id;
    return {
      success: true,
      prId,
      pickupDate: pickupDateStr,
      pickupTime: pickupTimeStr,
      center: res.data?.incoming_center_name,
      message: res.data?.message || 'Pickup scheduled with Delhivery hub',
      data: res.data
    };
  } catch (err) {
    console.warn('[Delhivery Pickup Request Notice]:', err.response?.data || err.message);
    let parsedErr = err.response?.data?.prepaid ||
                    err.response?.data?.error ||
                    err.response?.data?.message ||
                    (typeof err.response?.data === 'string' ? err.response?.data : null) ||
                    err.message;
    if (typeof parsedErr === 'string' && parsedErr.includes('Client wallet balance')) {
      parsedErr = `Delhivery master account wallet balance is below the ₹500 minimum required for pickup dispatch (${parsedErr}). Please top up your Delhivery One wallet.`;
    }
    return {
      success: false,
      error: parsedErr
    };
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
 * Fetches the direct pre-signed Amazon S3 PDF packing slip URL from Delhivery
 * @param {string} waybill
 * @returns {Promise<string|null>}
 */
const fetchDelhiveryPackingSlipUrl = async (waybill) => {
  try {
    const cleanWaybill = String(waybill || '').trim();
    if (!cleanWaybill) return null;
    const res = await axios.get(`${BASE_URL}/api/p/packing_slip?wbns=${cleanWaybill}&pdf=true`, {
      headers: {
        'Authorization': `Token ${DELHIVERY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    const link = res.data?.packages?.[0]?.pdf_download_link;
    return link || null;
  } catch (err) {
    console.warn('[Delhivery Packing Slip Error]:', err.response?.data || err.message);
    return null;
  }
};

/**
 * Manifests parcel directly on Delhivery CMU network.
 * Accurately routes pickup to the seller's doorstep.
 *
 * @param {Object} shipment - Mongoose Shipment document
 * @param {Object} senderUser - Mongoose User document for the seller
 * @returns {Promise<Object>} Booking confirmation with AWB and status
 */
const createDelhiveryDirectOrder = async (shipment, senderUser, pickupOptions = {}) => {
  if (!DELHIVERY_API_KEY) {
    throw new Error('DELHIVERY_API_KEY is not configured');
  }

  // 1. Allocate live waybill
  const waybill = await generateDelhiveryWaybill(1);
  if (!waybill) {
    throw new Error('Failed to allocate live waybill from Delhivery');
  }

  // 2. Ensure seller's doorstep warehouse is registered in Delhivery HQ
  const warehouseName = await ensureDelhiveryWarehouse(senderUser, shipment);

  // 3. Format pickup (seller) and delivery (buyer) details
  const pickupPincode = String(shipment.senderPincode || senderUser?.pickupAddress?.pincode || senderUser?.pincode || '700049').replace(/\D/g, '').slice(0, 6);
  let pickupCity = (shipment.senderCity || senderUser?.pickupAddress?.city || senderUser?.city || '').trim();
  let pickupState = (shipment.senderState || senderUser?.pickupAddress?.state || senderUser?.state || '').trim();
  if (!pickupCity) pickupCity = 'Kolkata';
  if (!pickupState) pickupState = 'West Bengal';

  let pickupAddress = (shipment.senderAddress || senderUser?.pickupAddress?.street || senderUser?.address || 'Seller Doorstep').trim();
  // Strip duplicate trailing city/state/pin if already present in street line so Delhivery label prints cleanly
  pickupAddress = pickupAddress.replace(/,\s*Kolkata.*$/i, '').trim() || pickupAddress;

  const pickupName = (shipment.senderName || senderUser?.businessName || senderUser?.fullName || 'SecureKaro Seller').trim();
  const pickupPhone = String(shipment.senderPhone || senderUser?.phone || '9999999999').replace(/\D/g, '').slice(-10);

  const deliveryPincode = String(shipment.receiverPincode || '110001').replace(/\D/g, '').slice(0, 6);
  let deliveryCity = (shipment.receiverCity || '').trim();
  let deliveryState = (shipment.receiverState || '').trim();
  if (!deliveryCity) deliveryCity = 'Kolkata';
  if (!deliveryState) deliveryState = 'West Bengal';

  const deliveryAddress = (shipment.receiverAddress || 'Buyer Address').trim();
  const deliveryName = (shipment.receiverName || 'Buyer').trim();
  const deliveryPhone = String(shipment.receiverPhone || '9876543210').replace(/\D/g, '').slice(-10);

  const weightKg = parseFloat(shipment.parcelWeight || shipment.weight || 0.5);
  const isCod = Boolean(
    (shipment.paymentMode || '').toLowerCase() === 'cod' ||
    (shipment.paymentMethod || '').toLowerCase() === 'cod' ||
    shipment.isCod
  );
  const totalAmount = parseFloat(shipment.amount || shipment.codAmount || shipment.escrowAmount || shipment.totalAmount || shipment.itemPrice || 0);

  const shipmentData = {
    shipments: [
      {
        pickup_location: warehouseName,
        name: deliveryName,
        add: deliveryAddress,
        pin: deliveryPincode,
        city: deliveryCity,
        state: deliveryState,
        country: 'India',
        phone: deliveryPhone,
        order: shipment.shipmentId || `ORD_${Date.now()}`,
        payment_mode: isCod ? 'COD' : 'Pre-paid',
        return_pin: pickupPincode,
        return_city: pickupCity,
        return_phone: pickupPhone,
        return_add: pickupAddress,
        return_state: pickupState,
        return_country: 'India',
        products_desc: shipment.description || shipment.itemDescription || 'Consumer Merchandise',
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
      name: warehouseName,
      add: pickupAddress,
      city: pickupCity,
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

    console.log(`✅ [Delhivery Direct Manifest]: Created order for ${shipment.shipmentId}. Response:`, JSON.stringify(res.data));

    const firstPkg = Array.isArray(res.data?.packages) ? res.data.packages[0] : null;
    const pkgStatus = firstPkg?.status;
    const pkgRemarks = Array.isArray(firstPkg?.remarks) ? firstPkg.remarks.join(', ') : '';

    if (pkgStatus === 'Fail') {
      console.error(`❌ [Delhivery Direct Manifest Rejected]: ${pkgRemarks}`);
      throw new Error(`Delhivery booking failed: ${pkgRemarks || 'Manifest rejected by Delhivery'}`);
    }

    // Attempt to resolve direct pre-signed Amazon S3 packing slip URL
    let s3LabelUrl = await fetchDelhiveryPackingSlipUrl(waybill);
    const finalLabelUrl = s3LabelUrl || `/api/v1/shipments/${shipment.shipmentId}/label?format=pdf`;

    // Compute optimal IST pickup date & time
    const nowUtc = new Date();
    const istTime = new Date(nowUtc.getTime() + (5.5 * 60 * 60 * 1000));
    const istHour = istTime.getUTCHours();

    let pDate = new Date(istTime.getTime());
    let pTimeStr = '14:00:00';

    if (istHour >= 14) {
      // Past 2:00 PM IST -> Schedule for next business day morning
      pDate.setUTCDate(pDate.getUTCDate() + 1);
      if (pDate.getUTCDay() === 0) pDate.setUTCDate(pDate.getUTCDate() + 1);
      pTimeStr = '11:00:00';
    } else {
      pTimeStr = '15:00:00';
    }

    const yyyy = pDate.getUTCFullYear();
    const mm = String(pDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(pDate.getUTCDate()).padStart(2, '0');
    const pDateStr = pickupOptions.pickupDateStr || `${yyyy}-${mm}-${dd}`;
    const finalPickupTime = pickupOptions.pickupTimeStr || pTimeStr;

    // Immediately schedule First Mile Pickup Request with Delhivery HQ
    let pickupResult = null;
    try {
      pickupResult = await requestDelhiveryPickup(warehouseName, pDateStr, finalPickupTime, 1);
    } catch (prErr) {
      console.warn('[Delhivery PR Dispatch Exception]:', prErr.message);
    }

    return {
      success: true,
      awbCode: waybill,
      carrierSlug: 'delhivery',
      courierName: 'Delhivery Express (Direct)',
      bookingRef: waybill,
      status: 'BOOKED',
      pickupId: pickupResult?.prId || null,
      pickupStatus: pickupResult?.success ? 'Pickup Scheduled' : 'Ready to ship',
      pickupError: pickupResult?.success ? null : (pickupResult?.error || null),
      pickupDate: pDateStr,
      pickupTime: finalPickupTime,
      labelUrl: finalLabelUrl,
      data: res.data
    };

  } catch (err) {
    console.error('[Delhivery Direct Manifest Error]:', err.response?.data || err.message);
    throw new Error(`Delhivery booking failed: ${err.response?.data?.error || err.message}`);
  }
};

/**
 * Cancel shipment in Delhivery Direct API
 * @param {string} waybill
 * @returns {Promise<{success: boolean, message: string}>}
 */
const cancelDelhiveryDirectOrder = async (waybill) => {
  if (!waybill) return { success: false, message: 'No waybill provided' };
  try {
    const cleanWaybill = String(waybill).trim();
    const res = await axios.post(`${BASE_URL}/api/p/edit`, {
      waybill: cleanWaybill,
      cancellation: 'true'
    }, {
      headers: {
        'Authorization': `Token ${DELHIVERY_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000
    });
    console.log(`[Delhivery Direct Cancel] Response for waybill ${cleanWaybill}:`, res.data);
    return {
      success: true,
      message: res.data?.message || 'Delhivery shipment cancellation requested'
    };
  } catch (err) {
    console.warn('[Delhivery Direct Cancel Error]:', err.response?.data || err.message);
    return { success: false, message: err.response?.data?.message || err.message };
  }
};

module.exports = {
  fetchDirectDelhiveryRate,
  checkDelhiveryServiceability,
  generateDelhiveryWaybill,
  createDelhiveryDirectOrder,
  cancelDelhiveryDirectOrder,
  fetchDelhiveryPackingSlipUrl,
  requestDelhiveryPickup
};

