/**
 * YouPI-PG Payment Service
 * ========================
 * Self-hosted UPI payment gateway integration for SecureKaro.
 * Replaces commercial gateway (Cashfree/Razorpay) for all UPI prepayment flows.
 *
 * Security model:
 *  - Every outbound request carries the merchant API key in X-Merchant-Key header.
 *  - Every inbound webhook is verified with HMAC-SHA256 timing-safe comparison.
 *  - Amount is cross-verified (webhook paise == shipment amount paise) before escrow release.
 *  - Idempotency: youpiPaymentId stored on shipment prevents double-processing.
 */

const crypto = require('crypto');
const axios = require('axios').default;

// ── Environment Config ──────────────────────────────────────────────────────
const YOUPI_BASE_URL   = process.env.YOUPI_PG_BASE_URL   || 'http://localhost:6100';
const YOUPI_MERCHANT_ID   = process.env.YOUPI_MERCHANT_ID   || '';
const YOUPI_MERCHANT_KEY  = process.env.YOUPI_MERCHANT_KEY  || '';   // X-Merchant-Key header
const YOUPI_WEBHOOK_SECRET = process.env.YOUPI_WEBHOOK_SECRET || '';  // HMAC signing secret

// ── Helper: Amount in Paise ─────────────────────────────────────────────────
const toPaise = (rupeesOrPaise) => {
  const n = Number(rupeesOrPaise);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid amount: ${rupeesOrPaise}`);
  // If value is already in paise (>= 100 and integer), keep it; otherwise convert
  if (Number.isInteger(n) && n >= 100) return n;
  return Math.round(n * 100);
};

// ── Helper: Build auth headers ──────────────────────────────────────────────
const buildHeaders = () => ({
  'Content-Type':  'application/json',
  'X-Merchant-Key': YOUPI_MERCHANT_KEY,
  ...(YOUPI_MERCHANT_ID ? { 'X-Merchant-ID': YOUPI_MERCHANT_ID } : {})
});

/**
 * Creates a YouPI-PG UPI payment session for a shipment.
 *
 * @param {Object} params
 * @param {string}  params.shipmentId   - SecureKaro shipment ID (used as orderId)
 * @param {number}  params.amount       - Amount in INR rupees (e.g. 499)
 * @param {string}  params.returnUrl    - Absolute URL to redirect buyer after payment
 * @param {string}  [params.customerPhone] - Buyer phone (optional metadata)
 * @param {string}  [params.customerName]  - Buyer name (optional metadata)
 *
 * @returns {Promise<{
 *   paymentId: string,
 *   checkoutUrl: string,
 *   status: string,
 *   amountPaise: number
 * }>}
 */
const createPaymentSession = async ({ shipmentId, amount, returnUrl, customerPhone, customerName }) => {
  const amountPaise = toPaise(amount);

  const payload = {
    orderId:   shipmentId,
    amount:    String(Number(amountPaise) / 100),   // YouPI expects rupees string e.g. "499.00"
    currency:  'INR',
    returnUrl: returnUrl || null,
    metadata: {
      platform: 'securekaro',
      shipmentId,
      ...(customerPhone ? { customerPhone } : {}),
      ...(customerName  ? { customerName  } : {})
    }
  };

  console.log(`[YouPI] Creating payment session for shipment ${shipmentId} (₹${Number(amountPaise)/100})...`);

  try {
    const response = await axios.post(`${YOUPI_BASE_URL}/api/v1/payments`, payload, {
      headers: buildHeaders(),
      timeout: 10000
    });

    const data = response.data;
    if (!data.paymentId || !data.checkoutUrl) {
      throw new Error('YouPI-PG returned incomplete session data');
    }

    console.log(`[YouPI] Session created: paymentId=${data.paymentId}, checkoutUrl=${data.checkoutUrl}`);
    return {
      paymentId:   data.paymentId,
      checkoutUrl: data.checkoutUrl,
      status:      data.status || 'INITIATED',
      amountPaise
    };

  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.error(`[YouPI] Failed to create payment session for ${shipmentId}: ${errMsg}`);
    
    // In dev / test mode fallback: generate standard YouPI checkout portal URL so development/demo flow never breaks
    if (process.env.NODE_ENV !== 'production' || !process.env.YOUPI_PG_BASE_URL) {
      const fallbackId = `youpi_${crypto.randomBytes(8).toString('hex')}`;
      const checkoutPortal = process.env.YOUPI_PORTAL_URL || 'http://localhost:7000';
      console.warn(`[YouPI] Fallback checkout URL generated for dev/testing: ${fallbackId}`);
      return {
        paymentId: fallbackId,
        checkoutUrl: `${checkoutPortal}/checkout/${fallbackId}?orderId=${encodeURIComponent(shipmentId)}&amount=${amount}&currency=INR`,
        status: 'INITIATED',
        amountPaise,
        isFallback: true
      };
    }

    throw new Error(`YouPI payment session creation failed: ${errMsg}`);
  }
};

/**
 * Fetches the current status of a YouPI payment session.
 *
 * @param {string} paymentId - YouPI payment session UUID
 * @returns {Promise<{ status: string, amountPaise: number, completedAt: string|null }>}
 */
const getPaymentStatus = async (paymentId) => {
  try {
    const response = await axios.get(`${YOUPI_BASE_URL}/api/v1/payments/${paymentId}`, {
      headers: buildHeaders(),
      timeout: 8000
    });

    const d = response.data;
    return {
      status:      d.status,
      amountPaise: Number(d.amountPaise || 0),
      completedAt: d.completedAt || null,
      method:      d.method || 'UPI',
      orderId:     d.orderId || ''
    };
  } catch (err) {
    const errMsg = err.response?.data?.error || err.message;
    console.warn(`[YouPI] getPaymentStatus failed for ${paymentId}: ${errMsg}`);
    throw new Error(`YouPI status check failed: ${errMsg}`);
  }
};

/**
 * Verifies an inbound YouPI-PG webhook HMAC-SHA256 signature.
 *
 * YouPI-PG signs the raw JSON body with the shared webhookSecret using HMAC-SHA256
 * and sends the signature as:  X-YouPI-Signature: sha256=<hex>
 *
 * SECURITY: Uses crypto.timingSafeEqual to prevent timing side-channel attacks.
 *
 * @param {string|Buffer} rawBody  - Raw request body (MUST be Buffer, not parsed object)
 * @param {string} signatureHeader - Value of X-YouPI-Signature header
 * @returns {boolean}
 */
const verifyWebhookSignature = (rawBody, signatureHeader) => {
  if (!YOUPI_WEBHOOK_SECRET) {
    console.error('[YouPI] YOUPI_WEBHOOK_SECRET is not configured — rejecting webhook');
    return false;
  }

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }

  // Strip "sha256=" prefix
  const receivedSig = signatureHeader.replace(/^sha256=/, '').trim();
  if (!receivedSig || receivedSig.length < 32) return false;

  const expectedSig = crypto
    .createHmac('sha256', YOUPI_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedSig, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  } catch {
    // Buffer lengths differ → signature mismatch
    return false;
  }
};

/**
 * Validates that the webhook payment amount (paise) matches the expected shipment amount.
 * Prevents amount-tampering attacks where an attacker pays ₹1 for a ₹499 order.
 *
 * @param {number} webhookAmountPaise   - Amount from YouPI webhook payload
 * @param {number} shipmentAmountRupees - Amount stored on SecureKaro shipment
 * @returns {boolean}
 */
const verifyAmountMatch = (webhookAmountPaise, shipmentAmountRupees) => {
  const expectedPaise = Math.round(Number(shipmentAmountRupees) * 100);
  return Number(webhookAmountPaise) === expectedPaise;
};

module.exports = {
  createPaymentSession,
  getPaymentStatus,
  verifyWebhookSignature,
  verifyAmountMatch,
  toPaise,
  YOUPI_BASE_URL,
  YOUPI_WEBHOOK_SECRET
};
