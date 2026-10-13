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

  // Return cached token if valid
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
      // Tokens are typically valid for 10 days; cache for 6 days
      tokenExpiresAt = Date.now() + 6 * 24 * 60 * 60 * 1000;
      console.log('[SHIPROCKET] Authenticated successfully with account:', email);
      return cachedToken;
    }
  } catch (err) {
    console.error('[SHIPROCKET AUTH ERROR]:', err.response?.data?.message || err.message);
  }

  return null;
};

/**
 * Get the active/primary pickup location nickname (e.g. 'Home')
 */
const getPrimaryPickupLocation = async () => {
  const token = await getAuthToken();
  if (!token) return 'Home';

  try {
    const res = await axios.get('https://apiv2.shiprocket.in/v1/external/settings/company/pickup', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });

    const addresses = res.data?.data?.shipping_address || [];
    if (addresses.length > 0) {
      const primary = addresses.find(a => a.is_primary_location === 1) || addresses[0];
      return primary.pickup_location || 'Home';
    }
  } catch (err) {
    console.warn('[SHIPROCKET PICKUP LOOKUP NOTICE]:', err.message);
  }

  return 'Home';
};

/**
 * Automatically create and push order to Shiprocket
 *
 * @param {object} shipment - Mongoose Shipment document
 * @param {object} senderUser - Mongoose User document or sender object
 * @returns {object|null} Shiprocket order details { order_id, shipment_id, status }
 */
const createOrderInShiprocket = async (shipment, senderUser) => {
  const token = await getAuthToken();
  if (!token) {
    console.warn('[SHIPROCKET] Skipping order push: Not authenticated');
    return null;
  }

  try {
    const pickupLocation = await getPrimaryPickupLocation();

    // Clean and validate receiver info
    const receiverName = (shipment.receiverName || 'Valued Customer').trim();
    const receiverPhone = (shipment.receiverPhone || '9999999999').replace(/\D/g, '').slice(-10);
    const receiverAddress = (shipment.receiverAddress || 'Delivery Address').trim();
    const receiverPincode = (shipment.receiverPincode || '700001').replace(/\D/g, '').slice(0, 6);
    
    // Determine city and state
    let receiverCity = 'Kolkata';
    let receiverState = 'West Bengal';
    if (shipment.city) {
      if (shipment.city.includes('->') || shipment.city.includes('→')) {
        const dest = shipment.city.split(/->|→/)[1]?.trim();
        if (dest) receiverCity = dest;
      } else {
        receiverCity = shipment.city.trim();
      }
    }

    const orderAmount = Number(shipment.amount) || 100;
    const itemName = (shipment.description || 'General Merchandise').trim();
    const weightKg = Number(shipment.parcelWeight) || 0.5;

    // Build the Shiprocket adhoc order creation payload
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const orderPayload = {
      order_id: shipment.shipmentId,
      order_date: nowStr,
      pickup_location: pickupLocation,
      channel_id: '',
      comment: `SecureKaro Escrow Protected Order #${shipment.shipmentId}`,
      billing_customer_name: receiverName,
      billing_last_name: '',
      billing_address: receiverAddress,
      billing_address_2: '',
      billing_city: receiverCity,
      billing_pincode: receiverPincode,
      billing_state: receiverState,
      billing_country: 'India',
      billing_email: `${receiverPhone}@securekaro.in`,
      billing_phone: receiverPhone,
      shipping_is_billing: true,
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
      payment_method: shipment.paymentMode === 'cod' ? 'COD' : 'Prepaid',
      shipping_charges: Number(shipment.deliveryCharge) || 0,
      giftwrap_charges: 0,
      transaction_charges: 0,
      total_discount: 0,
      sub_total: orderAmount,
      length: Number(shipment.parcelLength) || 15,
      breadth: Number(shipment.parcelWidth) || 10,
      height: Number(shipment.parcelHeight) || 5,
      weight: weightKg
    };

    console.log(`[SHIPROCKET ORDER SYNC] Pushing order ${shipment.shipmentId} to Shiprocket...`);

    const response = await axios.post('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', orderPayload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });

    const resData = response.data;
    if (resData && (resData.order_id || resData.status === 'NEW')) {
      console.log(`✅ [SHIPROCKET ORDER SYNC SUCCESS] Order ${shipment.shipmentId} created in Shiprocket! SR Order ID: ${resData.order_id}, Shipment ID: ${resData.shipment_id}`);

      // Save Shiprocket IDs on the shipment
      shipment.shiprocketOrderId = resData.order_id || null;
      shipment.shiprocketShipmentId = resData.shipment_id || null;
      shipment.pickupAggregator = 'Shiprocket Multi-Carrier API';
      await shipment.save();

      return resData;
    } else {
      console.warn('[SHIPROCKET ORDER SYNC NOTICE]:', resData);
      return resData;
    }
  } catch (err) {
    const errorDetails = err.response?.data || err.message;
    console.error(`❌ [SHIPROCKET ORDER SYNC FAILED] for ${shipment.shipmentId}:`, errorDetails);
    return null;
  }
};

module.exports = {
  getAuthToken,
  getPrimaryPickupLocation,
  createOrderInShiprocket
};
