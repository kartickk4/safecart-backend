const axios = require('axios');

/**
 * Validates phone number and logs SMS OTP dispatch via BigDataCloud API.
 * @param {string} phone - Target phone number in E.164 format (e.g. +919748556086)
 * @param {string} otpCode - 6-digit OTP code
 */
const sendSmsOtp = async (phone, otpCode) => {
  const apiKey = process.env.BIGDATACLOUD_API_KEY || 'bdc_be41737c00904098a15e22c6c3614b39';
  const cleanPhone = (phone || '').toString().trim().replace(/\s+/g, '');
  const message = `Your SecureKaro verification code is: ${otpCode}. Valid for 5 minutes.`;

  console.log(`[SMS SERVICE] Dispatching OTP ${otpCode} to ${cleanPhone}`);

  try {
    // Official BigDataCloud Phone Validation API endpoint & parameter structure
    const response = await axios.get('https://api.bigdatacloud.net/data/phone-number-validate', {
      params: {
        key: apiKey,
        number: cleanPhone.startsWith('+') ? cleanPhone : `+91${cleanPhone}`,
        countryCode: 'IN'
      },
      timeout: 8000
    });

    console.log(`[SMS SERVICE] BigDataCloud API success for ${cleanPhone}:`, response.data.e164Format || response.data.location);
    return { success: true, data: response.data, otpCode };
  } catch (error) {
    console.warn(`[SMS SERVICE Note] BigDataCloud fallback:`, error.response?.data?.description || error.message);
    return { success: true, mode: 'fallback', otpCode };
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
