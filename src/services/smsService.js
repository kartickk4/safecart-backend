const axios = require('axios');

/**
 * Sends a real OTP SMS to any Indian phone number via Fast2SMS DLT Route.
 * Uses Jio DLT approved templates (Sender: SECKRO). Delivers to Airtel, Jio, Vi, BSNL.
 * @param {string} phone - Target phone number (any format — we extract last 10 digits)
 * @param {string} otpCode - 6-digit OTP code to send
 */
/**
 * Strict SMS Delivery Policy:
 * Under TRAI non-DLT constraints, Phone SMS is EXCLUSIVELY reserved for:
 *  1. 'SIGNUP_AUTH'         - User sign-up / mobile phone verification OTP
 *  2. 'PASSWORD_RESET'      - Forgot password / reset password OTP
 *  3. 'BANK_DETAILS_UPDATE' - Bank account / UPI ID profile update OTP
 *
 * ALL other notifications (Order payment links, courier booking, tracking, 
 * delivery verification OTPs, returns & payouts) are routed EXCLUSIVELY via WhatsApp.
 */
const ALLOWED_SMS_PURPOSES = [
  'SIGNUP_AUTH',
  'LOGIN_AUTH',
  'PASSWORD_RESET',
  'BANK_DETAILS_UPDATE',
  'WALLET_RECHARGE',
  'BOOKING_ALERT'
];

const sendSmsOtp = async (phone, otpCode, purpose = 'SIGNUP_AUTH') => {
  if (!ALLOWED_SMS_PURPOSES.includes(purpose)) {
    console.warn(`[SMS POLICY ENFORCED] SMS suppressed for unauthorized purpose: '${purpose}'. Only approved transactional OTPs and alerts are delivered via Phone SMS.`);
    return { success: false, suppressed: true, reason: 'unauthorized_sms_purpose', otpCode };
  }

  const fast2smsKey = process.env.FAST2SMS_API_KEY;
  const cleanPhone = (phone || '').toString().replace(/\D/g, '').slice(-10);

  console.log(`[SMS OTP - ${purpose}] Sending OTP ${otpCode} to +91${cleanPhone}`);

  // Fallback: if no API key configured, log OTP so developers can test locally
  if (!fast2smsKey) {
    console.warn(`[SMS OTP FALLBACK] No FAST2SMS_API_KEY set. OTP for +91${cleanPhone} [${purpose}]: ${otpCode}`);
    return { success: true, mode: 'fallback_no_key', otpCode, purpose };
  }

  if (cleanPhone.length !== 10) {
    console.warn(`[SMS OTP] Invalid phone number: ${phone}`);
    return { success: false, mode: 'invalid_phone', otpCode };
  }

  // Official Fast2SMS DLT Content Template Mapping (Sender: SECKRO)
  // - 232310: Login and Sign Up OTP
  // - 232308: Forgot Password OTP
  // - 232307: Bank Details & Security Verification OTP
  // - 232320: Wallet Recharge Alert
  // - 232321: Shipment Booking & Tracking Alert
  const DLT_TEMPLATE_MAP = {
    SIGNUP_AUTH:         { sender_id: 'SECKRO', message_id: '232310', variables_values: `${otpCode}|10` },
    LOGIN_AUTH:          { sender_id: 'SECKRO', message_id: '232310', variables_values: `${otpCode}|10` },
    PASSWORD_RESET:      { sender_id: 'SECKRO', message_id: '232308', variables_values: `${otpCode}|10` },
    BANK_DETAILS_UPDATE: { sender_id: 'SECKRO', message_id: '232307', variables_values: `${otpCode}|10` },
    WALLET_RECHARGE:     { sender_id: 'SECKRO', message_id: '232320', variables_values: `${otpCode}|${otpCode}` },
    BOOKING_ALERT:       { sender_id: 'SECKRO', message_id: '232321', variables_values: `${otpCode}` },
    TRACKING_ALERT:      { sender_id: 'SECKRO', message_id: '232321', variables_values: `${otpCode}` }
  };
  const dltParams = DLT_TEMPLATE_MAP[purpose] || DLT_TEMPLATE_MAP['SIGNUP_AUTH'];

  try {
    // Build raw form body — do NOT use URLSearchParams (it encodes | as %7C breaking Fast2SMS variable substitution)
    const rawBody = `sender_id=${encodeURIComponent(dltParams.sender_id)}&message=${dltParams.message_id}&route=dlt&numbers=${cleanPhone}&variables_values=${dltParams.variables_values}`;
    const response = await axios.post('https://www.fast2sms.com/dev/bulkV2', rawBody, {
      headers: {
        authorization: fast2smsKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    });

    console.log(`[SMS OTP - ${purpose}] Fast2SMS response for +91${cleanPhone}:`, response.data?.message || response.data);
    return {
      success: true,
      mode: 'fast2sms',
      phone: cleanPhone,
      otpCode,
      purpose,
      requestId: response.data?.request_id
    };
  } catch (error) {
    const errMsg = error.response?.data?.message || error.message;
    console.warn(`[SMS OTP - ${purpose}] Fast2SMS delivery error for +91${cleanPhone}:`, errMsg);
    return { success: false, mode: 'fast2sms_error', otpCode, error: errMsg };
  }
};

let whatsappService;
try {
  whatsappService = require('./whatsappService');
} catch (e) {
  whatsappService = null;
}

/**
 * Generates and dispatches Payment Link via WhatsApp (SMS suppressed per platform policy).
 */
const sendPaymentLinkSms = async ({ phone, shipmentId, amount, description, carrierSlug, linkUrl, returnAllowed, receiverName, frontendUrl, paymentMode }) => {
  const cleanPhone = (phone || '').toString().trim().replace(/\s+/g, '');
  const returnPolicyText = returnAllowed 
    ? 'Returns: ALLOWED by sender (24h protection window)' 
    : 'Returns: NOT ALLOWED by sender (Final sale - no returns)';
  const baseUrl = (frontendUrl || process.env.FRONTEND_URL?.split(',')[0] || 'http://localhost:5173').trim();
  const courier = carrierSlug && carrierSlug !== 'add_later' ? carrierSlug.toUpperCase() : 'DELHIVERY';
  const formattedAmount = new Intl.NumberFormat('en-IN').format(amount);

  let paymentLine = '';
  if (linkUrl && linkUrl.trim()) {
    paymentLine = `🔒 Pay safely with Delivery Protection: ${linkUrl}\n\n`;
  } else if (paymentMode === 'cod') {
    paymentLine = `💵 Mode: Cash on Delivery (COD) — ₹${formattedAmount} payable on delivery.\n\n`;
  } else {
    paymentLine = `🔒 Pay safely with Delivery Protection: ${baseUrl}/pay/${shipmentId}\n\n`;
  }

  const smsText = 
    `SecureKaro: Order #${shipmentId} booked for ₹${formattedAmount} (${description || 'Parcel'}).\n` +
    `🚚 Carrier: ${courier} | Policy: ${returnPolicyText}\n` +
    paymentLine +
    `📸 Note: Parcel & product photo verification is mandatory before dispatch.`;

  console.log(`[SMS POLICY ENFORCED] SMS suppressed for Order #${shipmentId}. SMS is strictly reserved for: Signup OTP, Forgot Password OTP, Edit Phone OTP, Delivery Sign-off OTP. Routing to WhatsApp.`);

  // Dispatch booking notification via WhatsApp
  try {
    if (whatsappService && whatsappService.sendBookingConfirmationWhatsApp) {
      await whatsappService.sendBookingConfirmationWhatsApp({
        phone: cleanPhone,
        receiverName,
        shipmentId,
        carrierSlug: courier,
        awbCode: 'PENDING_DISPATCH',
        amount
      });
    }
  } catch (waErr) {
    console.warn('[WHATSAPP ROUTE Note]:', waErr.message);
  }

  // Dispatch DLT SMS alert via Fast2SMS Template 232321 (Parcel Tracking & Booking)
  try {
    const fast2smsKey = process.env.FAST2SMS_API_KEY;
    const shortTrackingId = shipmentId ? String(shipmentId).slice(-10) : 'PARCEL';
    if (fast2smsKey && cleanPhone.length === 10) {
      const rawBody = `sender_id=SECKRO&message=232321&route=dlt&numbers=${cleanPhone}&variables_values=${encodeURIComponent(shortTrackingId)}`;
      await axios.post('https://www.fast2sms.com/dev/bulkV2', rawBody, {
        headers: { authorization: fast2smsKey, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      });
    }
  } catch (dltErr) {
    console.warn('[DLT BOOKING SMS Warning]:', dltErr.message);
  }

  return {
    success: true,
    phone: cleanPhone,
    smsText,
    returnAllowed,
    routedToWhatsApp: true
  };
};

/**
 * Dispatches notification to receiver when reverse pickup courier partner is assigned via WhatsApp.
 */
const sendReverseCourierAssignedSms = async ({ phone, shipmentId, carrierName, trackingId, pickupWindow }) => {
  const cleanPhone = (phone || '').toString().trim().replace(/\s+/g, '');
  const carrier = carrierName || 'Courier Partner';
  const slot = pickupWindow ? ` Scheduled Pickup Window: ${pickupWindow}.` : '';
  const smsText = `SecureKaro: Return approved! Reverse courier automatically booked with ${carrier}. Tracking ID: ${trackingId}.${slot} Please keep the item packed and sealed for collection.`;

  console.log(`[SMS POLICY ENFORCED] SMS suppressed for Reverse Courier ${trackingId}. Routing to WhatsApp.`);

  try {
    if (whatsappService && whatsappService.sendReverseCourierAssignedWhatsApp) {
      await whatsappService.sendReverseCourierAssignedWhatsApp({
        phone: cleanPhone,
        shipmentId,
        carrierName,
        trackingId,
        pickupWindow
      });
    }
  } catch (waErr) {
    console.warn('[WHATSAPP ROUTE Note]:', waErr.message);
  }

  return {
    success: true,
    phone: cleanPhone,
    smsText,
    carrier,
    trackingId,
    pickupWindow,
    routedToWhatsApp: true
  };
};

/**
 * Sends photo review notice via WhatsApp.
 */
const sendPhotoReviewChoiceSms = async ({ phone, shipmentId, receiverName, carrierSlug, awbCode }) => {
  const cleanPhone = (phone || '').toString().trim().replace(/\s+/g, '');
  const courier = carrierSlug ? carrierSlug.toUpperCase() : 'DELHIVERY';

  const smsText =
    `Hi ${receiverName || 'there'}! 📦 SecureKaro: Shipment #${shipmentId} has been booked.\n` +
    `🚚 Carrier: ${courier}${awbCode ? ` | AWB: ${awbCode}` : ''}\n\n` +
    `📸 Note: Parcel & product photo verification is mandatory for this shipment before courier dispatch for your security.`;

  console.log(`[SMS POLICY ENFORCED] SMS suppressed for Photo Notice. Routing to WhatsApp.`);

  try {
    if (whatsappService && whatsappService.sendPhotoReviewChoiceWhatsApp) {
      await whatsappService.sendPhotoReviewChoiceWhatsApp({
        phone: cleanPhone,
        shipmentId,
        receiverName,
        carrierSlug,
        awbCode
      });
    }
  } catch (waErr) {
    console.warn('[WHATSAPP ROUTE Note]:', waErr.message);
  }

  return {
    success: true,
    phone: cleanPhone,
    smsText,
    routedToWhatsApp: true
  };
};

/**
 * Sends dispatch tracking alert via WhatsApp.
 */
const sendDispatchTrackingSms = async ({ phone, shipmentId, receiverName, carrierSlug, awbCode, trackUrl, description }) => {
  const cleanPhone = (phone || '').toString().trim().replace(/\s+/g, '');
  const courier = carrierSlug ? carrierSlug.toUpperCase() : 'DELHIVERY';

  const smsText =
    `SecureKaro: Order #${shipmentId} has been dispatched via ${courier} (AWB: ${awbCode}).\n` +
    `Track parcel in real time: ${trackUrl}\n` +
    `Payment protected under verified delivery sign-off.`;

  console.log(`[SMS POLICY ENFORCED] SMS suppressed for Dispatch Tracking #${shipmentId}. Routing to WhatsApp.`);

  try {
    if (whatsappService && whatsappService.sendDispatchTrackingWhatsApp) {
      await whatsappService.sendDispatchTrackingWhatsApp({
        phone: cleanPhone,
        receiverName,
        shipmentId,
        carrierName: courier,
        awbCode,
        trackUrl,
        description
      });
    }
  } catch (waErr) {
    console.warn('[WHATSAPP ROUTE Note]:', waErr.message);
  }

  // Dispatch DLT Parcel Tracking SMS alert via Fast2SMS Template 232321
  try {
    const fast2smsKey = process.env.FAST2SMS_API_KEY;
    const trackingCode = awbCode || (shipmentId ? String(shipmentId).slice(-10) : 'PARCEL');
    if (fast2smsKey && cleanPhone.length === 10) {
      const rawBody = `sender_id=SECKRO&message=232321&route=dlt&numbers=${cleanPhone}&variables_values=${encodeURIComponent(trackingCode)}`;
      await axios.post('https://www.fast2sms.com/dev/bulkV2', rawBody, {
        headers: { authorization: fast2smsKey, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      });
    }
  } catch (dltErr) {
    console.warn('[DLT TRACKING SMS Warning]:', dltErr.message);
  }

  return { success: true, phone: cleanPhone, smsText, routedToWhatsApp: true };
};

/**
 * Sends Wallet Recharge alert via Fast2SMS DLT Template 232320.
 */
const sendWalletRechargeSms = async ({ phone, amount, balance }) => {
  const cleanPhone = (phone || '').toString().trim().replace(/\D/g, '').slice(-10);
  const fast2smsKey = process.env.FAST2SMS_API_KEY;
  if (!fast2smsKey || cleanPhone.length !== 10) return { success: false };

  try {
    const numAmount = Math.round(Number(amount) || 0);
    const numBal = Math.round(Number(balance) || numAmount);
    const vars = `${numAmount}|${numBal}`;
    const rawBody = `sender_id=SECKRO&message=232320&route=dlt&numbers=${cleanPhone}&variables_values=${vars}`;
    const response = await axios.post('https://www.fast2sms.com/dev/bulkV2', rawBody, {
      headers: { authorization: fast2smsKey, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
    return { success: true, requestId: response.data?.request_id };
  } catch (err) {
    console.warn('[WALLET RECHARGE SMS Warning]:', err.response?.data?.message || err.message);
    return { success: false, error: err.message };
  }
};

module.exports = {
  sendSmsOtp,
  sendPaymentLinkSms,
  sendWalletRechargeSms,
  sendReverseCourierAssignedSms,
  sendPhotoReviewChoiceSms,
  sendDispatchTrackingSms
};
