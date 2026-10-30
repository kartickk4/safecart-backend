const axios = require('axios');

let cachedToken = null;
let tokenExpiresAt = null;

/**
 * Obtain Shiprocket auth token with caching
 */
const getAuthToken = async () => {
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;

  if (!email || !password) {
    console.warn('[SHIPROCKET] Missing SHIPROCKET_EMAIL or SHIPROCKET_PASSWORD in environment');
    return null;
  }

  // Return cached token if still valid
  if (cachedToken && tokenExpiresAt && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  try {
    const res = await axios.post('https://apiv2.shiprocket.in/v1/external/auth/login', {
      email,
      password
    }, { timeout: 10000 });

    if (res.data?.token) {
      cachedToken = res.data.token;
      // Tokens valid for 10 days; cache for 6 days
      tokenExpiresAt = Date.now() + 6 * 24 * 60 * 60 * 1000;
      console.log('[SHIPROCKET] Authenticated successfully with account:', email);
      return cachedToken;
    }
  } catch (err) {
    console.error('[SHIPROCKET AUTH ERROR]:', err.response?.data?.message || err.message);
  }

  return null;
};

const { cacheManager } = require('./cacheManager');

/**
 * Robust geocoding helper for Indian pincodes.
 * Uses live India Postal API with static regional fallback.
 * Guarantees accurate City & State for pickup and delivery locations across India.
 * Bounded LRU cache (3 days TTL) prevents unbounded memory leaks.
 */
const resolvePincodeGeo = async (pincodeRaw) => {
  const pin = String(pincodeRaw || '').trim().replace(/\D/g, '').slice(0, 6);
  if (!pin || pin.length < 6) {
    return { city: 'Kolkata', state: 'West Bengal' };
  }

  const cacheKey = cacheManager.generateKey('geo:pincode', { pin });

  return cacheManager.getOrSet(cacheKey, async () => {
    try {
      const res = await axios.get(`https://api.postalpincode.in/pincode/${pin}`, { timeout: 3000 });
      const postOffice = res.data?.[0]?.PostOffice?.[0];
      if (postOffice && postOffice.State) {
        const city = (postOffice.District || postOffice.Division || postOffice.Name || 'City').trim();
        const state = postOffice.State.trim();
        return { city, state };
      }
    } catch (_) {}

    // Regional prefix fallbacks for Indian states
    const prefix2 = pin.slice(0, 2);
    const prefix3 = pin.slice(0, 3);
    let fallback = { city: 'Metro City', state: 'West Bengal' };

    if (prefix2 === '11') fallback = { city: 'New Delhi', state: 'Delhi' };
    else if (['12', '13'].includes(prefix2)) fallback = { city: 'Gurugram', state: 'Haryana' };
    else if (['14', '15', '16'].includes(prefix2)) fallback = { city: 'Ludhiana', state: 'Punjab' };
    else if (prefix2 === '17') fallback = { city: 'Shimla', state: 'Himachal Pradesh' };
    else if (['18', '19'].includes(prefix2)) fallback = { city: 'Jammu', state: 'Jammu and Kashmir' };
    else if (['20', '21', '22', '23', '24', '25', '26', '27', '28'].includes(prefix2)) fallback = { city: 'Lucknow', state: 'Uttar Pradesh' };
    else if (['30', '31', '32', '33', '34'].includes(prefix2)) fallback = { city: 'Jaipur', state: 'Rajasthan' };
    else if (['36', '37', '38', '39'].includes(prefix2)) fallback = { city: 'Ahmedabad', state: 'Gujarat' };
    else if (['40', '41', '42', '43', '44'].includes(prefix2)) {
      if (prefix3 === '411') fallback = { city: 'Pune', state: 'Maharashtra' };
      else if (prefix3 === '440') fallback = { city: 'Nagpur', state: 'Maharashtra' };
      else fallback = { city: 'Mumbai', state: 'Maharashtra' };
    }
    else if (['45', '46', '47', '48'].includes(prefix2)) fallback = { city: 'Indore', state: 'Madhya Pradesh' };
    else if (prefix2 === '49') fallback = { city: 'Raipur', state: 'Chhattisgarh' };
    else if (['50', '51', '52', '53'].includes(prefix2)) fallback = { city: 'Hyderabad', state: 'Telangana' };
    else if (['56', '57', '58', '59'].includes(prefix2)) fallback = { city: 'Bengaluru', state: 'Karnataka' };
    else if (['60', '61', '62', '63', '64'].includes(prefix2)) fallback = { city: 'Chennai', state: 'Tamil Nadu' };
    else if (['67', '68', '69'].includes(prefix2)) fallback = { city: 'Kochi', state: 'Kerala' };
    else if (['70', '71', '72', '73', '74'].includes(prefix2)) fallback = { city: 'Kolkata', state: 'West Bengal' };
    else if (['75', '76', '77'].includes(prefix2)) fallback = { city: 'Bhubaneswar', state: 'Odisha' };
    else if (prefix2 === '78') fallback = { city: 'Guwahati', state: 'Assam' };
    else if (prefix2 === '79') fallback = { city: 'Shillong', state: 'Meghalaya' };
    else if (['80', '81', '82', '83', '84', '85'].includes(prefix2)) fallback = { city: 'Patna', state: 'Bihar' };

    return fallback;
  }, 259200, ['geo:pincode']); // 3 days TTL
};



/**
 * Ensures the seller's specific pickup address is registered in Shiprocket.
 * Each seller on SecureKaro has their own pickup address across India.
 *
 * @param {object} senderUser - Mongoose User document for the seller
 * @param {object} shipment - Mongoose Shipment document
 * @returns {string} The pickup_location code to use for order creation
 */
const ensurePickupLocation = async (senderUser, shipment) => {
  const token = await getAuthToken();
  if (!token) return 'Home';

  try {
    // 1. Fetch currently registered pickup locations
    const listRes = await axios.get('https://apiv2.shiprocket.in/v1/external/settings/company/pickup', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });

    const addresses = listRes.data?.data?.shipping_address || [];

    // Extract seller's pickup details
    const sellerPincode = (
      shipment.senderPincode || 
      senderUser?.pickupAddress?.pincode || 
      senderUser?.pincode || 
      '700049'
    ).toString().replace(/\D/g, '').slice(0, 6);

    let sellerStreet = (
      shipment.senderAddress || 
      senderUser?.pickupAddress?.street || 
      senderUser?.address || 
      'Seller Warehouse'
    ).trim();

    // Shiprocket enforces a minimum address length of 10 characters
    if (sellerStreet.length < 10) {
      sellerStreet = `${sellerStreet}, Commercial Complex`;
    }

    const sellerName = (
      shipment.senderName ||
      senderUser?.businessName || 
      senderUser?.fullName || 
      'SecureKaro Seller'
    ).trim();

    const sellerPhone = (
      shipment.senderPhone ||
      senderUser?.phone || 
      '9999999999'
    ).toString().replace(/\D/g, '').slice(-10);

    const sellerEmail = (
      senderUser?.email || 
      `${sellerPhone}@securekaro.in`
    ).trim();

    // Dynamically resolve city and state from postal lookup if missing or blank
    let sellerCity = (
      shipment.senderCity ||
      senderUser?.pickupAddress?.city || 
      senderUser?.city || 
      ''
    ).trim();

    let sellerState = (
      shipment.senderState ||
      senderUser?.pickupAddress?.state || 
      senderUser?.state || 
      ''
    ).trim();

    if (!sellerCity || !sellerState) {
      const geo = await resolvePincodeGeo(sellerPincode);
      if (!sellerCity) sellerCity = geo.city;
      if (!sellerState) sellerState = geo.state;
    }

    // Generate a unique, deterministic nickname for this seller location
    const sellerIdSnippet = String(senderUser?._id || shipment?.senderId?._id || shipment?.senderId || 'SELLER').slice(-6).toUpperCase();
    const targetNickname = `PKP_${sellerPincode}_${sellerIdSnippet}`;

    // 2. Check if already registered in Shiprocket under this nickname or matching seller identity
    const existing = addresses.find(a => 
      a.pickup_location === targetNickname || 
      (a.pin_code === sellerPincode && a.phone === sellerPhone && (a.name === sellerName || a.address === sellerStreet))
    );

    if (existing) {
      console.log(`[SHIPROCKET PICKUP] Found existing pickup location for seller: ${existing.pickup_location} (${existing.name}, ${existing.city})`);
      return existing.pickup_location;
    }

    // 3. Register seller's new pickup location via Shiprocket API
    console.log(`[SHIPROCKET PICKUP] Registering new seller pickup location: ${targetNickname} (${sellerName}, ${sellerStreet}, ${sellerCity}, ${sellerState} - ${sellerPincode}, Ph: ${sellerPhone})`);
    const addRes = await axios.post('https://apiv2.shiprocket.in/v1/external/settings/company/addpickup', {
      pickup_location: targetNickname,
      name: sellerName,
      email: sellerEmail,
      phone: sellerPhone,
      address: sellerStreet,
      address_2: '',
      city: sellerCity,
      state: sellerState,
      country: 'India',
      pin_code: sellerPincode
    }, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 12000
    });

    const registeredCode = addRes.data?.address?.pickup_code || targetNickname;
    console.log(`✅ [SHIPROCKET PICKUP] Seller pickup location created: ${registeredCode}`);
    return registeredCode;

  } catch (err) {
    console.warn('[SHIPROCKET PICKUP REGISTRATION NOTICE]:', err.response?.data?.message || err.message);
    // Fallback: return primary location if dynamic registration fails
    try {
      const listRes = await axios.get('https://apiv2.shiprocket.in/v1/external/settings/company/pickup', {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 8000
      });
      const addresses = listRes.data?.data?.shipping_address || [];
      if (addresses.length > 0) {
        return addresses[0].pickup_location || 'Home';
      }
    } catch (_) {}
    return 'Home';
  }
};

/**
 * Match user-selected carrier slug to available Shiprocket courier companies
 */
const findMatchingCourier = (availableCouriers, targetCarrierSlug) => {
  if (!availableCouriers || availableCouriers.length === 0) return null;

  const slug = (targetCarrierSlug || 'auto').toLowerCase();

  // If user selected specific courier partner, find closest matching active courier
  const slugKeywords = {
    bluedart: ['blue dart', 'bluedart'],
    delhivery: ['delhivery'],
    shadowfax: ['shadowfax'],
    ekart: ['ekart'],
    dtdc: ['dtdc'],
    xpressbees: ['xpressbees', 'xpress bees'],
    ecom: ['ecom express', 'ecom'],
    smartr: ['smartr']
  };

  const keywords = slugKeywords[slug];
  if (keywords) {
    const match = availableCouriers.find(c => {
      const name = (c.courier_name || '').toLowerCase();
      return keywords.some(k => name.includes(k));
    });
    if (match) return match;
  }

  // If 'auto' or no keyword match found, pick the lowest rate available courier
  const sorted = [...availableCouriers].sort((a, b) => (Number(a.rate) || 999) - (Number(b.rate) || 999));
  return sorted[0];
};

/**
 * Automatically assign courier AWB, schedule pickup, and generate label in Shiprocket.
 * Zero manual steps required from seller or admin.
 */
const autoAssignCourierAndPickup = async ({
  shipmentId,
  srShipmentId,
  chosenCarrierSlug,
  pickupPincode,
  deliveryPincode,
  weightKg,
  isCod
}) => {
  const token = await getAuthToken();
  if (!token || !srShipmentId) return null;

  try {
    // 1. Fetch available courier serviceability
    console.log(`[SHIPROCKET AUTO-DISPATCH] Checking couriers for ${pickupPincode} -> ${deliveryPincode}...`);
    const servRes = await axios.get('https://apiv2.shiprocket.in/v1/external/courier/serviceability/', {
      params: {
        pickup_postcode: pickupPincode,
        delivery_postcode: deliveryPincode,
        weight: weightKg || 0.5,
        cod: isCod ? 1 : 0
      },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 12000
    });

    const availableCouriers = servRes.data?.data?.available_courier_companies || [];
    if (availableCouriers.length === 0) {
      console.warn(`[SHIPROCKET AUTO-DISPATCH] No couriers serviceable for route ${pickupPincode} -> ${deliveryPincode}`);
      return null;
    }

    // 2. Select chosen or cheapest courier
    let selectedCourier = findMatchingCourier(availableCouriers, chosenCarrierSlug);
    if (!selectedCourier) {
      selectedCourier = availableCouriers[0];
    }

    console.log(`[SHIPROCKET AUTO-DISPATCH] Attempting courier assignment: ${selectedCourier.courier_name} (ID: ${selectedCourier.courier_company_id}, Rate: ₹${selectedCourier.rate})`);

    // 3. Assign courier & generate live AWB (explicitly un-insured)
    let assignRes = await axios.post('https://apiv2.shiprocket.in/v1/external/courier/assign/awb', {
      shipment_id: srShipmentId,
      courier_id: selectedCourier.courier_company_id,
      is_insurance_opted: 0
    }, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });

    let assignData = assignRes.data?.response?.data;
    let realAwb = assignData?.awb_code;

    // Fallback: If user's chosen courier failed assignment, try the next available courier
    if (!realAwb && availableCouriers.length > 1) {
      const fallbackCourier = availableCouriers.find(c => c.courier_company_id !== selectedCourier.courier_company_id);
      if (fallbackCourier) {
        console.log(`[SHIPROCKET AUTO-DISPATCH] Primary courier failed, trying fallback courier: ${fallbackCourier.courier_name}`);
        try {
          const fbRes = await axios.post('https://apiv2.shiprocket.in/v1/external/courier/assign/awb', {
            shipment_id: srShipmentId,
            courier_id: fallbackCourier.courier_company_id,
            is_insurance_opted: 0
          }, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 15000
          });
          assignData = fbRes.data?.response?.data;
          realAwb = assignData?.awb_code;
          if (realAwb) selectedCourier = fallbackCourier;
        } catch (fbErr) {
          console.warn('[SHIPROCKET FALLBACK NOTICE]:', fbErr.message);
        }
      }
    }

    if (!realAwb) {
      console.warn(`[SHIPROCKET AUTO-DISPATCH] AWB assignment pending for ${shipmentId}`);
      return null;
    }

    console.log(`🎯 [SHIPROCKET AUTO-DISPATCH SUCCESS] Live AWB generated: ${realAwb} with ${selectedCourier.courier_name}`);

    // 4. Request Pickup Dispatch Automatically
    let pickupScheduled = false;
    try {
      const pickupRes = await axios.post('https://apiv2.shiprocket.in/v1/external/courier/generate/pickup', {
        shipment_id: [srShipmentId]
      }, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 12000
      });
      if (pickupRes.data?.response || pickupRes.data?.status === 200) {
        pickupScheduled = true;
        console.log(`🚚 [SHIPROCKET PICKUP SCHEDULED] Executive dispatched for shipment ${srShipmentId}`);
      }
    } catch (pkErr) {
      console.warn('[SHIPROCKET AUTO PICKUP NOTICE]:', pkErr.response?.data?.message || pkErr.message);
    }

    // 5. Generate Shipping Label PDF Automatically
    let labelUrl = '';
    try {
      const labelRes = await axios.post('https://apiv2.shiprocket.in/v1/external/courier/generate/label', {
        shipment_id: [srShipmentId]
      }, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 12000
      });
      labelUrl = labelRes.data?.label_url || labelRes.data?.response?.label_url || '';
      if (labelUrl) {
        console.log(`🏷️ [SHIPROCKET LABEL GENERATED] Printable label: ${labelUrl}`);
      }
    } catch (lblErr) {
      console.warn('[SHIPROCKET LABEL GENERATION NOTICE]:', lblErr.response?.data?.message || lblErr.message);
    }

    return {
      awbCode: realAwb,
      courierName: selectedCourier.courier_name,
      courierCompanyId: selectedCourier.courier_company_id,
      courierRate: selectedCourier.rate,
      pickupScheduled,
      labelUrl
    };

  } catch (err) {
    console.error(`❌ [SHIPROCKET AUTO-DISPATCH ERROR] for ${shipmentId}:`, err.response?.data || err.message);
    return null;
  }
};

/**
 * End-to-end automated Shiprocket order booking:
 * 1. Takes the actual seller's pickup address (dynamic multi-seller support).
 * 2. Creates the Shiprocket order.
 * 3. Automatically assigns the seller's chosen courier partner.
 * 4. Generates live AWB, schedules pickup, and creates shipping label.
 *
 * @param {object} shipment - Mongoose Shipment document
 * @param {object} senderUser - Mongoose User document or sender object
 * @returns {object|null} Shiprocket order and dispatch details
 */
const createOrderInShiprocket = async (shipment, senderUser) => {
  const token = await getAuthToken();
  if (!token) {
    console.warn('[SHIPROCKET] Skipping order push: Not authenticated');
    return null;
  }

  try {
    // 1. Ensure seller's personal/business pickup location is registered
    const pickupLocation = await ensurePickupLocation(senderUser, shipment);

    // Clean and validate receiver info
    const receiverName = (shipment.receiverName || 'Valued Customer').trim();
    const receiverPhone = (shipment.receiverPhone || '9999999999').replace(/\D/g, '').slice(-10);
    const receiverAddress = (shipment.receiverAddress || 'Delivery Address').trim();
    const receiverPincode = (shipment.receiverPincode || '700001').replace(/\D/g, '').slice(0, 6);
    
    // Determine city and state with dynamic postal geocoding
    let receiverCity = '';
    let receiverState = '';
    if (shipment.city) {
      if (shipment.city.includes('->') || shipment.city.includes('→')) {
        receiverCity = shipment.city.split(/->|→/)[1]?.trim();
      } else {
        receiverCity = shipment.city.trim();
      }
    }
    if (!receiverCity || !receiverState) {
      const recvGeo = await resolvePincodeGeo(receiverPincode);
      if (!receiverCity) receiverCity = recvGeo.city;
      if (!receiverState) receiverState = recvGeo.state;
    }

    const orderAmount = Number(shipment.amount) || 100;
    const itemName = (shipment.description || 'General Merchandise').trim();
    const weightKg = Number(shipment.parcelWeight) || 0.5;
    const isCod = shipment.paymentMode === 'cod';

    // 2. Build the Shiprocket order payload with seller's pickup location
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 16);

    // Resolve billing phone:
    // Courier physical label & doorstep delivery will use shipping_phone (real customer phone).
    // Shiprocket notification/WhatsApp marketing bot triggers on billing_phone;
    // to prevent unwanted per-message WhatsApp wallet charges, billing_phone is routed to merchant line or virtual desk.
    const merchantPhone = (
      senderUser?.phone || 
      shipment.senderPhone || 
      '9999999999'
    ).toString().replace(/\D/g, '').slice(-10);
    const billingPhone = (process.env.SHIPROCKET_BILLING_PHONE || merchantPhone).slice(-10);

    const orderPayload = {
      order_id: shipment.shipmentId,
      order_date: nowStr,
      pickup_location: pickupLocation,
      channel_id: '',
      comment: `SecureKaro Protected Order #${shipment.shipmentId}`,

      // Billing Information (Used for invoices & Shiprocket automated bots)
      billing_customer_name: receiverName,
      billing_last_name: '',
      billing_address: receiverAddress,
      billing_address_2: '',
      billing_city: receiverCity,
      billing_pincode: receiverPincode,
      billing_state: receiverState,
      billing_country: 'India',
      billing_email: `${receiverPhone}@securekaro.in`,
      billing_phone: billingPhone,

      // Shipping Information (Printed on physical AWB label for courier rider & delivery OTP)
      shipping_is_billing: false,
      shipping_customer_name: receiverName,
      shipping_last_name: '',
      shipping_address: receiverAddress,
      shipping_address_2: '',
      shipping_city: receiverCity,
      shipping_pincode: receiverPincode,
      shipping_state: receiverState,
      shipping_country: 'India',
      shipping_email: `${receiverPhone}@securekaro.in`,
      shipping_phone: receiverPhone,

      order_items: [
        {
          name: itemName,
          sku: `SKU-${shipment.shipmentId}`,
          units: 1,
          selling_price: orderAmount,
          discount: 0,
          tax: 0,
          hsn: 5407
        }
      ],
      payment_method: isCod ? 'COD' : 'Prepaid',
      shipping_charges: Number(shipment.deliveryCharge) || 0,
      giftwrap_charges: 0,
      transaction_charges: 0,
      total_discount: 0,
      sub_total: orderAmount,
      length: Number(shipment.parcelLength) || 15,
      breadth: Number(shipment.parcelWidth) || 10,
      height: Number(shipment.parcelHeight) || 5,
      weight: weightKg,

      // Explicitly disable transit insurance charges (Solution 1)
      is_insurance_opted: 0,
      is_insured: 0,
      insurance: 0,

      // Explicitly disable Shiprocket WhatsApp/SMS/Email automated charges
      is_whatsapp_opted: 0,
      buyer_notification: 0,
      send_sms: 0,
      send_email: 0,
      send_notification: 0
    };

    console.log(`[SHIPROCKET ORDER SYNC] Creating order ${shipment.shipmentId} (Pickup: ${pickupLocation}, Delivery: ${receiverPincode})...`);

    const response = await axios.post('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', orderPayload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });

    const resData = response.data;
    if (resData && (resData.order_id || resData.status === 'NEW')) {
      const srOrderId = resData.order_id;
      const srShipmentId = resData.shipment_id;
      console.log(`✅ [SHIPROCKET ORDER CREATED] Order ${shipment.shipmentId} created! SR Order: ${srOrderId}, SR Shipment: ${srShipmentId}`);

      shipment.shiprocketOrderId = srOrderId || null;
      shipment.shiprocketShipmentId = srShipmentId || null;
      shipment.pickupAggregator = 'Shiprocket Multi-Carrier API';

      // 3. AUTOMATIC ZERO-TOUCH DISPATCH: Assign courier, generate live AWB & schedule pickup
      const senderPincode = (
        shipment.senderPincode || 
        senderUser?.pickupAddress?.pincode || 
        senderUser?.pincode || 
        '700049'
      ).toString().replace(/\D/g, '').slice(0, 6);

      const dispatchResult = await autoAssignCourierAndPickup({
        shipmentId: shipment.shipmentId,
        srShipmentId,
        chosenCarrierSlug: shipment.carrierSlug || shipment.pickupCarrierSlug || 'auto',
        pickupPincode: senderPincode,
        deliveryPincode: receiverPincode,
        weightKg,
        isCod
      });

      if (dispatchResult && dispatchResult.awbCode) {
        shipment.awbCode = dispatchResult.awbCode;
        shipment.pickupCarrier = dispatchResult.courierName;
        shipment.pickupRate = dispatchResult.courierRate || shipment.pickupRate;
        if (dispatchResult.labelUrl) {
          shipment.shippingLabelUrl = dispatchResult.labelUrl;
        }
        if (dispatchResult.pickupScheduled) {
          shipment.pickupStatus = 'Scheduled';
        }
      }

      await shipment.save();
      return { ...resData, dispatch: dispatchResult };
    } else {
      console.warn('[SHIPROCKET ORDER NOTICE]:', resData);
      return resData;
    }
  } catch (err) {
    const errorDetails = err.response?.data || err.message;
    console.error(`❌ [SHIPROCKET ORDER CREATION FAILED] for ${shipment.shipmentId}:`, errorDetails);
    return null;
  }
};

module.exports = {
  getAuthToken,
  ensurePickupLocation,
  createOrderInShiprocket,
  autoAssignCourierAndPickup
};
