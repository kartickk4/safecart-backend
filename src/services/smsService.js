const axios = require('axios');

/**
 * Sends a real OTP SMS to any Indian phone number via Fast2SMS Non-DLT OTP Route.
 * No DLT registration required. Delivers to Airtel, Jio, Vi, BSNL instantly.
 * @param {string} phone - Target phone number (any format — we extract last 10 digits)
 * @param {string} otpCode - 6-digit OTP code to send
 */
const sendSmsOtp = async (phone, otpCode) => {
  const fast2smsKey = process.env.FAST2SMS_API_KEY;
  const cleanPhone = (phone || '').toString().replace(/\D/g, '').slice(-10);

  console.log(`[SMS OTP] Sending OTP ${otpCode} to +91${cleanPhone}`);

  // Fallback: if no API key configured, log OTP so developers can test locally
  if (!fast2smsKey) {
    console.warn(`[SMS OTP FALLBACK] No FAST2SMS_API_KEY set. OTP for +91${cleanPhone}: ${otpCode}`);
    return { success: true, mode: 'fallback_no_key', otpCode };
  }

  if (cleanPhone.length !== 10) {
    console.warn(`[SMS OTP] Invalid phone number: ${phone}`);
    return { success: false, mode: 'invalid_phone', otpCode };
  }

  try {
    const response = await axios.get('https://www.fast2sms.com/dev/bulkV2', {
      params: {
        authorization: fast2smsKey,
        variables_values: otpCode,
        route: 'otp',
        numbers: cleanPhone
      },
      timeout: 10000
    });

    console.log(`[SMS OTP] Fast2SMS response for +91${cleanPhone}:`, response.data?.message || response.data);
    return {
      success: true,
      mode: 'fast2sms',
      phone: cleanPhone,
      otpCode,
      requestId: response.data?.request_id
    };
  } catch (error) {
    const errMsg = error.response?.data?.message || error.message;
    console.warn(`[SMS OTP] Fast2SMS delivery error for +91${cleanPhone}:`, errMsg);
    // Still return the OTP so the auth flow does not break if SMS fails
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
    paymentLine = `🔒 Pay safely into escrow: ${linkUrl}\n\n`;
  } else if (paymentMode === 'cod') {
    paymentLine = `💵 Mode: Cash on Delivery (COD) — ₹${formattedAmount} payable on delivery.\n\n`;
  } else {
    paymentLine = `🔒 Pay safely into escrow: ${baseUrl}/pay/${shipmentId}\n\n`;
  }

  const smsText = 
    `SecureKaro: Order #${shipmentId} booked for ₹${formattedAmount} (${description || 'Parcel'}).\n` +
    `🚚 Carrier: ${courier} | Policy: ${returnPolicyText}\n` +
    paymentLine +
    `📸 Note: Parcel & product photo verification is mandatory before dispatch.`;

  console.log(`[SMS POLICY ENFORCED] SMS suppressed for Order #${shipmentId}. SMS is strictly reserved for: Signup OTP, Forgot Password OTP, Edit Phone OTP, Delivery Sign-off OTP. Routing to WhatsApp.`);

  // Dispatch via WhatsApp
  try {
    if (whatsappService && whatsappService.sendPaymentLinkWhatsApp) {
      await whatsappService.sendPaymentLinkWhatsApp({
        phone: cleanPhone,
        receiverName,
        shipmentId,
        amount,
        description,
        linkUrl: linkUrl || `${baseUrl}/pay/${shipmentId}`
      });
    }
  } catch (waErr) {
    console.warn('[WHATSAPP ROUTE Note]:', waErr.message);
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
  const smsText = `SecureKaro Escrow: Return approved! Reverse courier automatically booked with ${carrier}. Tracking ID: ${trackingId}.${slot} Please keep the item packed and sealed for collection.`;

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
    `Payment protected in escrow.`;

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

  return { success: true, phone: cleanPhone, smsText, routedToWhatsApp: true };
};

module.exports = {
  sendSmsOtp,
  sendPaymentLinkSms,
  sendReverseCourierAssignedSms,
  sendPhotoReviewChoiceSms,
  sendDispatchTrackingSms
};
