/**
 * whatsappService.js
 * WhatsApp Business API integration for sending payment links.
 * Uses Meta WhatsApp Cloud API. Logs/simulates if API keys are absent.
 */

const axios = require('axios');

const WA_TOKEN    = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WA_ENABLED  = !!(WA_TOKEN && WA_PHONE_ID);

/**
 * Sends a payment link via WhatsApp to the receiver.
 */
const sendPaymentLinkWhatsApp = async ({ phone, receiverName, shipmentId, amount, description, linkUrl }) => {
  const digits = (phone || '').toString().replace(/\D/g, '').slice(-10);
  const e164Phone = digits.length === 10 ? `91${digits}` : (phone || '').toString().replace(/\D/g, '');

  const messageText =
    `🛡️ *SecureKaro Order Payment Request*\n\n` +
    `Hello ${receiverName || 'there'}! 👋\n\n` +
    `*Shipment ID:* ${shipmentId}\n` +
    `*Item:* ${description || 'Parcel'}\n` +
    `*Amount to Pay:* ₹${Number(amount).toLocaleString('en-IN')}\n\n` +
    `Your order is protected under *SecureKaro Delivery Verification*. ` +
    `Funds are safely disbursed to the seller only after successful delivery confirmation.\n\n` +
    `💳 *Pay Securely Here:*\n${linkUrl}\n\n` +
    `_Powered by SecureKaro — India's Premier Courier Aggregator & Delivery Protection Platform_`;

  console.log(`[WHATSAPP] ${WA_ENABLED ? 'Sending' : 'SIMULATING'} payment link to +${e164Phone}`);
  console.log(`[WHATSAPP] Message:\n${messageText}`);

  if (!WA_ENABLED) {
    return {
      success: true,
      mode: 'simulated',
      phone: e164Phone,
      messageText
    };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: e164Phone,
        type: 'text',
        text: { body: messageText }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    return {
      success: true,
      mode: 'live',
      phone: e164Phone,
      messageId: response.data?.messages?.[0]?.id
    };
  } catch (err) {
    console.warn('[WHATSAPP] API error:', err.response?.data || err.message);
    return {
      success: false,
      mode: 'failed',
      error: err.response?.data?.error?.message || err.message
    };
  }
};

/**
 * Sends a shipment booked confirmation via WhatsApp.
 */
const sendBookingConfirmationWhatsApp = async ({ phone, receiverName, shipmentId, carrierName, awbCode, eta }) => {
  const digits = (phone || '').toString().replace(/\D/g, '').slice(-10);
  const e164Phone = digits.length === 10 ? `91${digits}` : (phone || '').toString().replace(/\D/g, '');

  const messageText =
    `✅ *SecureKaro — Shipment Booked!*\n\n` +
    `Hello ${receiverName || 'there'}!\n\n` +
    `Your shipment has been booked:\n` +
    `📦 *Shipment ID:* ${shipmentId}\n` +
    `🚚 *Carrier:* ${carrierName}\n` +
    `📬 *AWB Code:* ${awbCode}\n` +
    `⏱️ *Estimated Delivery:* ${eta}\n\n` +
    `Track your parcel anytime on SecureKaro.\n` +
    `_Your payment is protected under verified delivery sign-off._`;

  console.log(`[WHATSAPP] ${WA_ENABLED ? 'Sending' : 'SIMULATING'} booking confirmation to +${e164Phone}`);

  if (!WA_ENABLED) {
    return { success: true, mode: 'simulated', phone: e164Phone };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: e164Phone,
        type: 'text',
        text: { body: messageText }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return { success: true, mode: 'live', messageId: response.data?.messages?.[0]?.id };
  } catch (err) {
    return { success: false, mode: 'failed', error: err.message };
  }
};

/**
 * Sends a parcel dispatch & live tracking link alert via WhatsApp.
 */
const sendDispatchTrackingWhatsApp = async ({ phone, receiverName, shipmentId, carrierName, awbCode, trackUrl, description }) => {
  const digits = (phone || '').toString().replace(/\D/g, '').slice(-10);
  const e164Phone = digits.length === 10 ? `91${digits}` : (phone || '').toString().replace(/\D/g, '');

  const messageText =
    `🚚 *SecureKaro — Parcel Dispatched!*\n\n` +
    `Hello ${receiverName || 'there'}! 👋\n\n` +
    `Your order *${shipmentId}*${description ? ` (${description})` : ''} has been dispatched with courier partner *${carrierName || 'Courier'}*.\n\n` +
    `📦 *Carrier:* ${carrierName || 'Courier Partner'}\n` +
    `🔢 *AWB / Tracking Code:* ${awbCode}\n` +
    `🛡️ *Protection Status:* Payment Secured Under Verified Delivery\n\n` +
    `📍 *Live Real-Time Tracking (Zero Login Required):*\n${trackUrl}\n\n` +
    `_Your payment remains safely protected until you inspect and confirm delivery._`;

  console.log(`[WHATSAPP] ${WA_ENABLED ? 'Sending' : 'SIMULATING'} dispatch tracking alert to +${e164Phone}`);
  console.log(`[WHATSAPP] Message:\n${messageText}`);

  if (!WA_ENABLED) {
    return { success: true, mode: 'simulated', phone: e164Phone, messageText };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: e164Phone,
        type: 'text',
        text: { body: messageText }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return { success: true, mode: 'live', phone: e164Phone, messageId: response.data?.messages?.[0]?.id };
  } catch (err) {
    console.warn('[WHATSAPP] Dispatch tracking API note:', err.response?.data || err.message);
    return { success: false, mode: 'failed', error: err.response?.data?.error?.message || err.message };
  }
};

/**
 * Sends reverse courier assignment notification via WhatsApp.
 */
const sendReverseCourierAssignedWhatsApp = async ({ phone, shipmentId, carrierName, trackingId, pickupWindow }) => {
  const digits = (phone || '').toString().replace(/\D/g, '').slice(-10);
  const e164Phone = digits.length === 10 ? `91${digits}` : (phone || '').toString().replace(/\D/g, '');
  const carrier = carrierName || 'Courier Partner';
  const slot = pickupWindow ? ` Scheduled Pickup Window: ${pickupWindow}.` : '';

  const messageText =
    `🔄 *SecureKaro: Return Approved!*\n\n` +
    `Your reverse courier has been automatically booked for Shipment *#${shipmentId}* with *${carrier}*.\n\n` +
    `📦 *Carrier:* ${carrier}\n` +
    `🔢 *Tracking ID:* ${trackingId}\n` +
    (slot ? `⏱️${slot}\n\n` : '\n') +
    `Please keep the item safely packed and sealed for collection.\n` +
    `_Your refund is safeguarded under SecureKaro buyer protection._`;

  console.log(`[WHATSAPP] ${WA_ENABLED ? 'Sending' : 'SIMULATING'} reverse courier alert to +${e164Phone}`);

  if (!WA_ENABLED) {
    return { success: true, mode: 'simulated', phone: e164Phone, messageText };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: e164Phone,
        type: 'text',
        text: { body: messageText }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return { success: true, mode: 'live', phone: e164Phone, messageId: response.data?.messages?.[0]?.id };
  } catch (err) {
    console.warn('[WHATSAPP] Reverse courier API note:', err.response?.data || err.message);
    return { success: false, mode: 'failed', error: err.response?.data?.error?.message || err.message };
  }
};

/**
 * Sends photo review mandatory notice via WhatsApp.
 */
const sendPhotoReviewChoiceWhatsApp = async ({ phone, shipmentId, receiverName, carrierSlug, awbCode }) => {
  const digits = (phone || '').toString().replace(/\D/g, '').slice(-10);
  const e164Phone = digits.length === 10 ? `91${digits}` : (phone || '').toString().replace(/\D/g, '');
  const courier = carrierSlug ? carrierSlug.toUpperCase() : 'DELHIVERY';

  const messageText =
    `Hi ${receiverName || 'there'}! 👋\n\n` +
    `📦 *SecureKaro: Shipment #${shipmentId}* has been booked.\n` +
    `🚚 *Carrier:* ${courier}${awbCode ? ` | AWB: ${awbCode}` : ''}\n\n` +
    `📸 *Safety Note:* Parcel & product photo verification is mandatory for this shipment before courier dispatch for your security.\n` +
    `_Your payment remains secured under verified delivery protection._`;

  console.log(`[WHATSAPP] ${WA_ENABLED ? 'Sending' : 'SIMULATING'} photo review choice to +${e164Phone}`);

  if (!WA_ENABLED) {
    return { success: true, mode: 'simulated', phone: e164Phone, messageText };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: e164Phone,
        type: 'text',
        text: { body: messageText }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return { success: true, mode: 'live', phone: e164Phone, messageId: response.data?.messages?.[0]?.id };
  } catch (err) {
    console.warn('[WHATSAPP] Photo review API note:', err.response?.data || err.message);
    return { success: false, mode: 'failed', error: err.response?.data?.error?.message || err.message };
  }
};

/**
 * Sends a delivery confirmation sign-off OTP via WhatsApp to the receiver.
 */
const sendDeliveryOtpWhatsApp = async ({ phone, receiverName, shipmentId, otp, isReplacement }) => {
  const digits = (phone || '').toString().replace(/\D/g, '').slice(-10);
  const e164Phone = digits.length === 10 ? `91${digits}` : (phone || '').toString().replace(/\D/g, '');

  const parcelType = isReplacement ? 'Replacement Parcel' : 'Parcel';
  const messageText =
    `🔐 *SecureKaro — Delivery Verification OTP*\n\n` +
    `Hello ${receiverName || 'there'}! 👋\n\n` +
    `Your OTP for confirming delivery of *${parcelType} #${shipmentId}* is:\n\n` +
    `*${otp}*\n\n` +
    `⏱️ Valid for *10 minutes*.\n` +
    `⚠️ Please enter this OTP on the delivery verification screen ONLY after physically inspecting your package.\n\n` +
    `_Powered by SecureKaro Delivery Protection_`;

  console.log(`[WHATSAPP] ${WA_ENABLED ? 'Sending' : 'SIMULATING'} delivery OTP to +${e164Phone}`);

  if (!WA_ENABLED) {
    return { success: true, mode: 'simulated', phone: e164Phone, messageText, otp };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: e164Phone,
        type: 'text',
        text: { body: messageText }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return { success: true, mode: 'live', phone: e164Phone, messageId: response.data?.messages?.[0]?.id };
  } catch (err) {
    console.warn('[WHATSAPP] Delivery OTP API note:', err.response?.data || err.message);
    return { success: false, mode: 'failed', error: err.response?.data?.error?.message || err.message };
  }
};

/**
 * Sends payout released notification via WhatsApp.
 */
const sendPayoutReleasedWhatsApp = async ({ phone, senderName, shipmentId, amount, netPayout, method }) => {
  const digits = (phone || '').toString().replace(/\D/g, '').slice(-10);
  const e164Phone = digits.length === 10 ? `91${digits}` : (phone || '').toString().replace(/\D/g, '');

  const messageText =
    `💰 *SecureKaro — Payout Released!*\n\n` +
    `Hello ${senderName || 'Merchant'}! 🎉\n\n` +
    `Order *#${shipmentId}* delivery has been confirmed and verified.\n\n` +
    `💵 *Order Value:* ₹${Number(amount || 0).toLocaleString('en-IN')}\n` +
    `✅ *Net Payout Released:* ₹${Number(netPayout || amount || 0).toLocaleString('en-IN')}\n` +
    `🏦 *Credited To:* ${method || 'Merchant Wallet Balance'}\n\n` +
    `You can withdraw your funds anytime to your registered bank account or UPI ID.\n\n` +
    `_Thank you for shipping with SecureKaro!_`;

  console.log(`[WHATSAPP] ${WA_ENABLED ? 'Sending' : 'SIMULATING'} payout notification to +${e164Phone}`);

  if (!WA_ENABLED) {
    return { success: true, mode: 'simulated', phone: e164Phone, messageText };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: e164Phone,
        type: 'text',
        text: { body: messageText }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return { success: true, mode: 'live', phone: e164Phone, messageId: response.data?.messages?.[0]?.id };
  } catch (err) {
    console.warn('[WHATSAPP] Payout WhatsApp error:', err.response?.data || err.message);
    return { success: false, mode: 'failed', error: err.message };
  }
};


/**
 * Autonomous NDR (Non-Delivery Report) Resolution Alert via WhatsApp
 * Automatically contacts the buyer when a delivery attempt fails with 1-click reattempt actions.
 */
const sendNdrResolutionWhatsApp = async ({ phone, receiverName, shipmentId, carrierName, awbCode, ndrReason, resolutionUrl }) => {
  const digits = (phone || '').toString().replace(/\D/g, '').slice(-10);
  const e164Phone = digits.length === 10 ? `91${digits}` : (phone || '').toString().replace(/\D/g, '');

  const carrier = carrierName || 'Courier Partner';
  const reason = ndrReason || 'Customer was unavailable / Door locked';

  const messageText =
    `⚠️ *Delivery Attempt Notice — SecureKaro Delivery Shield*\n\n` +
    `Hello ${receiverName || 'there'}! 👋\n\n` +
    `The courier executive from *${carrier}* attempted to deliver your order *${shipmentId}* (AWB: ${awbCode || 'Pending'}) today, but the delivery could not be completed.\n\n` +
    `📌 *Courier Reason:* "${reason}"\n\n` +
    `To prevent this parcel from being returned to the seller (RTO), please choose your preferred delivery preference in 1-click:\n\n` +
    `👉 *Tap to Reschedule or Update Address:*\n${resolutionUrl}\n\n` +
    `Available 1-Click Options:\n` +
    `1️⃣ Reattempt Tomorrow (10:00 AM - 2:00 PM)\n` +
    `2️⃣ Reattempt Tomorrow (2:00 PM - 6:00 PM)\n` +
    `3️⃣ Update Delivery Address or Nearby Landmark\n` +
    `4️⃣ Request Delivery Call Before Arrival\n\n` +
    `_Your parcel & payment are protected under SecureKaro Verified Delivery Protection._`;

  console.log(`[WHATSAPP NDR] ${WA_ENABLED ? 'Sending' : 'SIMULATING'} NDR resolution alert to +${e164Phone}`);
  console.log(`[WHATSAPP NDR] Message:\n${messageText}`);

  if (!WA_ENABLED) {
    return { success: true, mode: 'simulated', phone: e164Phone, messageText };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: e164Phone,
        type: 'text',
        text: { body: messageText }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return { success: true, mode: 'live', phone: e164Phone, messageId: response.data?.messages?.[0]?.id };
  } catch (err) {
    console.warn('[WHATSAPP] NDR WhatsApp error:', err.response?.data || err.message);
    return { success: false, mode: 'failed', error: err.message };
  }
};

module.exports = { 
  sendPaymentLinkWhatsApp, 
  sendBookingConfirmationWhatsApp,
  sendDispatchTrackingWhatsApp,
  sendReverseCourierAssignedWhatsApp,
  sendPhotoReviewChoiceWhatsApp,
  sendDeliveryOtpWhatsApp,
  sendPayoutReleasedWhatsApp,
  sendNdrResolutionWhatsApp
};
