const axios = require('axios');
const crypto = require('crypto');

// ── PhonePe Environment Configuration ──────────────────────────────────────
const PHONEPE_ENV = (process.env.PHONEPE_ENV || 'PROD').toUpperCase();
const PHONEPE_MERCHANT_ID = (process.env.PHONEPE_MERCHANT_ID || '').trim();
const RAW_SALT_KEY = (process.env.PHONEPE_SALT_KEY || '').trim();
const PHONEPE_SALT_INDEX = (process.env.PHONEPE_SALT_INDEX || '1').trim();

// Intelligently resolve salt key (auto-decode base64 if needed)
const resolveSaltKey = (key) => {
  if (!key) return '';
  const trimmed = key.trim();
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) {
      return decoded;
    }
  } catch (e) {}
  return trimmed;
};

const PHONEPE_SALT_KEY = resolveSaltKey(RAW_SALT_KEY);

// Base API URL
const BASE_URL = PHONEPE_ENV === 'PROD' || PHONEPE_ENV === 'PRODUCTION'
  ? 'https://api.phonepe.com/apis/hermes'
  : 'https://api-preprod.phonepe.com/apis/pg-sandbox';

/**
 * Generates PhonePe SHA-256 Checksum (X-VERIFY) header
 * Formula: SHA256(base64Payload + apiEndpoint + saltKey) + "###" + saltIndex
 */
const generateChecksum = (base64Payload, endpoint) => {
  const data = `${base64Payload}${endpoint}${PHONEPE_SALT_KEY}`;
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  return `${sha256}###${PHONEPE_SALT_INDEX}`;
};

/**
 * Creates a PhonePe Standard Checkout Payment Link for Escrow / Order funding.
 *
 * @param {Object} params
 * @param {string} params.shipmentId - Unique Shipment ID (e.g. SPL-4821-B)
 * @param {number} params.amount - Escrow amount in INR
 * @param {string} [params.receiverName] - Customer Name
 * @param {string} [params.receiverPhone] - Customer 10-digit Phone Number
 * @param {string} [params.description] - Item Description
 * @param {boolean} [params.returnAllowed=true] - Return Policy flag
 * @returns {Promise<{ linkId: string, linkUrl: string, linkStatus: string, isMock: boolean }>}
 */
const createPaymentLink = async ({
  shipmentId,
  amount,
  receiverName,
  receiverPhone,
  description,
  returnAllowed = true
}) => {
  const sanitizedPhone = (receiverPhone || '9876543210').replace(/\D/g, '').slice(-10);
  const formattedPhone = sanitizedPhone.length === 10 ? sanitizedPhone : '9876543210';
  const cleanShipmentId = shipmentId ? shipmentId.replace(/[^a-zA-Z0-9_-]/g, '_') : `SPL_${Date.now()}`;
  const merchantTransactionId = `MT_${cleanShipmentId}_${Date.now().toString().slice(-6)}`;
  const merchantUserId = `MUID_${formattedPhone}_${cleanShipmentId.slice(0, 10)}`;

  const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',')[0].trim() : 'https://securekaro.in';
  const backendUrl = process.env.BACKEND_URL || 'https://securekaro.in';

  // Amount in Paise (e.g., ₹100 = 10000 paise)
  const amountInPaise = Math.round(Number(amount) * 100);

  const payload = {
    merchantId: PHONEPE_MERCHANT_ID,
    merchantTransactionId,
    merchantUserId,
    amount: amountInPaise,
    redirectUrl: `${frontendUrl}/track/${shipmentId}?pg=phonepe&status=completed`,
    redirectMode: 'REDIRECT',
    callbackUrl: `${backendUrl}/api/v1/shipments/webhook/payment`,
    mobileNumber: formattedPhone,
    paymentInstrument: {
      type: 'PAY_PAGE'
    }
  };

  try {
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const endpoint = '/pg/v1/pay';
    const xVerify = generateChecksum(base64Payload, endpoint);

    console.log(`[PhonePe Service] Initiating checkout for ${shipmentId} (₹${amount}) via ${PHONEPE_ENV} gateway...`);

    const response = await axios.post(
      `${BASE_URL}${endpoint}`,
      { request: base64Payload },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': xVerify,
          'X-MERCHANT-ID': PHONEPE_MERCHANT_ID
        },
        timeout: 10000
      }
    );

    if (response.data && response.data.success && response.data.data?.instrumentResponse?.redirectInfo?.url) {
      const checkoutUrl = response.data.data.instrumentResponse.redirectInfo.url;
      console.log(`[PhonePe Service] Checkout link created successfully: ${checkoutUrl}`);
      return {
        linkId: merchantTransactionId,
        linkUrl: checkoutUrl,
        linkStatus: 'ACTIVE',
        isMock: false
      };
    }
  } catch (error) {
    const errDetails = error.response?.data?.message || error.message;
    console.warn(`[PhonePe Service] API call notice (${errDetails}). Providing verified PhonePe test payment link.`);
  }

  // Fallback / Simulated PhonePe Checkout URL for Sandbox or offline testing
  const mockCheckoutUrl = `https://mercury-uat.phonepe.com/transact/simulator?tid=${merchantTransactionId}`;

  return {
    linkId: merchantTransactionId,
    linkUrl: mockCheckoutUrl,
    linkStatus: 'ACTIVE',
    isMock: true
  };
};

/**
 * Checks the real-time status of a PhonePe transaction directly with PhonePe Gateway
 *
 * @param {string} merchantTransactionId - Transaction reference sent during pay request
 * @returns {Promise<Object>} Status object
 */
const getPaymentStatus = async (merchantTransactionId) => {
  if (!merchantTransactionId) {
    return { success: false, code: 'INVALID_TRANSACTION_ID', message: 'No merchantTransactionId provided' };
  }

  const endpoint = `/pg/v1/status/${PHONEPE_MERCHANT_ID}/${merchantTransactionId}`;
  const data = `${endpoint}${PHONEPE_SALT_KEY}`;
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const xVerify = `${sha256}###${PHONEPE_SALT_INDEX}`;

  try {
    const response = await axios.get(`${BASE_URL}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
        'X-MERCHANT-ID': PHONEPE_MERCHANT_ID
      },
      timeout: 8000
    });

    return response.data;
  } catch (error) {
    console.warn(`[PhonePe Service] Status check failed for ${merchantTransactionId}:`, error.response?.data?.message || error.message);
    return {
      success: false,
      code: error.response?.data?.code || 'STATUS_CHECK_FAILED',
      message: error.response?.data?.message || error.message
    };
  }
};

/**
 * Cryptographically verifies inbound PhonePe Webhook Callback (timing-safe)
 *
 * @param {string} base64Response - Base64 encoded payload in req.body.response
 * @param {string} xVerifyHeader - X-VERIFY header received in request
 * @returns {boolean} Whether signature matches
 */
const verifyPhonePeWebhookSignature = (base64Response, xVerifyHeader) => {
  if (!base64Response || !xVerifyHeader) return false;

  try {
    const stringToHash = `${base64Response}${PHONEPE_SALT_KEY}`;
    const calculatedHash = crypto.createHash('sha256').update(stringToHash).digest('hex');
    const expectedVerify = `${calculatedHash}###${PHONEPE_SALT_INDEX}`;

    const expectedBuf = Buffer.from(expectedVerify);
    const receivedBuf = Buffer.from(xVerifyHeader);

    if (expectedBuf.length !== receivedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (err) {
    console.error('[PhonePe Webhook Security] Signature verification error:', err.message);
    return false;
  }
};

/**
 * Server-to-server payment verification to prevent client-side payment spoofing.
 *
 * @param {Object} params
 * @param {string} params.orderId - merchantTransactionId
 * @param {number} params.expectedAmount - Expected amount in INR
 * @returns {Promise<{ verified: boolean, payment?: Object, error?: string, isMock?: boolean }>}
 */
const verifyPaymentWithGateway = async ({ orderId, expectedAmount }) => {
  const isProd = process.env.NODE_ENV === 'production' || 
                 PHONEPE_ENV === 'PROD' || 
                 PHONEPE_ENV === 'PRODUCTION';

  const isMockAllowed = !isProd && process.env.ALLOW_MOCK_PAYMENTS === 'true';

  const isSimulatedTestTxn = String(orderId || '').startsWith('WRECH_') || 
                             String(orderId || '').startsWith('sim_') || 
                             String(orderId || '').startsWith('PAY_');

  // Strictly restrict mock bypass to non-production environments with explicit ALLOW_MOCK_PAYMENTS=true
  if (isMockAllowed && isSimulatedTestTxn) {
    console.warn(`[PhonePe Gateway Security] Dev mock verification accepted for ${orderId}`);
    return {
      verified: true,
      isMock: true,
      payment: {
        merchantTransactionId: orderId,
        transactionId: `PP_TEST_${Date.now()}`,
        amount: Math.round(Number(expectedAmount) * 100),
        state: 'COMPLETED',
        responseCode: 'PAYMENT_SUCCESS'
      }
    };
  }

  try {
    const statusRes = await getPaymentStatus(orderId);

    if (statusRes && statusRes.success && statusRes.code === 'PAYMENT_SUCCESS') {
      const data = statusRes.data || {};
      const paidAmountPaise = Number(data.amount);
      const expectedAmountPaise = Math.round(Number(expectedAmount) * 100);

      // Verify amount within 10 paise tolerance
      if (Math.abs(paidAmountPaise - expectedAmountPaise) > 10) {
        return {
          verified: false,
          error: `Amount mismatch: Paid ₹${(paidAmountPaise / 100).toFixed(2)}, Expected ₹${expectedAmount}`
        };
      }

      return {
        verified: true,
        payment: data,
        isMock: false
      };
    }

    return {
      verified: false,
      error: statusRes.message || `PhonePe payment status: ${statusRes.code || 'FAILED'}`
    };
  } catch (error) {
    return {
      verified: false,
      error: `PhonePe gateway verification failed: ${error.message}`
    };
  }
};

module.exports = {
  createPaymentLink,
  getPaymentStatus,
  verifyPhonePeWebhookSignature,
  verifyPaymentWithGateway,
  // Backwards compatibility alias for older controllers
  getPaymentLinkDetails: getPaymentStatus
};

