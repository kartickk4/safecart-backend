/**
 * whatsappService.js
 * Meta WhatsApp Cloud API integration for SecureKaro.
 * Uses official registered WhatsApp message templates (type: 'template') for
 * automated AWB alerts, booking confirmations, delivery OTPs, and NDR notifications.
 * Gracefully simulates in development if credentials are absent.
 */

const axios = require('axios');

const WA_TOKEN    = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WA_ENABLED  = !!(WA_TOKEN && WA_PHONE_ID);

// Configurable Meta Registered Template Names (Defaults match approved SecureKaro templates)
const TEMPLATES = {
  AWB_DISPATCH: process.env.WA_TEMPLATE_AWB_DISPATCH || 'securekaro_dispatch_tracking',
  BOOKING:      process.env.WA_TEMPLATE_BOOKING      || 'securekaro_booking_confirm',
  DELIVERY_OTP: process.env.WA_TEMPLATE_DELIVERY_OTP || 'securekaro_delivery_otp',
  NDR:          process.env.WA_TEMPLATE_NDR          || 'securekaro_ndr_alert',
  PAYMENT:      process.env.WA_TEMPLATE_PAYMENT      || 'securekaro_payment_request',
  PAYOUT:       process.env.WA_TEMPLATE_PAYOUT       || 'securekaro_payout_released',
  REVERSE_AWB:  process.env.WA_TEMPLATE_REVERSE_AWB  || 'securekaro_reverse_courier',
  PHOTO_REVIEW: process.env.WA_TEMPLATE_PHOTO_REVIEW || 'securekaro_photo_review'
};

/**
 * Normalizes an Indian phone number to E.164 without '+' (e.g. 917044255626)
 */
const formatE164Phone = (phone) => {
  const digits = (phone || '').toString().replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? `91${digits}` : (phone || '').toString().replace(/\D/g, '');
};

/**
 * Universal sender that invokes Meta WhatsApp Cloud API.
 * Uses registered Templates (type: 'template') as required by Meta for business-initiated notifications.
 * Falls back to direct text if a 24-hr customer service window is open.
 */
const sendWhatsAppMessage = async ({ phone, templateName, parameters = [], fallbackText = '', buttons = [] }) => {
  const e164Phone = formatE164Phone(phone);

  if (!e164Phone || e164Phone.length < 10) {
    console.warn('[WHATSAPP] Skipped: Invalid phone number:', phone);
    return { success: false, mode: 'invalid_phone', phone };
  }

  if (!WA_ENABLED) {
    console.log(`[WHATSAPP SIMULATED] to +${e164Phone} [Template: ${templateName || 'none'}]:\n${fallbackText}`);
    return {
      success: true,
      mode: 'simulated',
      phone: e164Phone,
      templateName,
      parameters,
      fallbackText
    };
  }

  // 1. Build Meta Template Components (if templateName is provided)
  let templatePayload = null;
  if (templateName) {
    const components = [];

    // Body parameters
    if (parameters && parameters.length > 0) {
      components.push({
        type: 'body',
        parameters: parameters.map(val => ({
          type: 'text',
          text: String(val !== undefined && val !== null ? val : '')
        }))
      });
    }

    // Button parameters (e.g. dynamic URL or copy-code)
    if (buttons && buttons.length > 0) {
      buttons.forEach((btn, index) => {
        components.push({
          type: 'button',
          sub_type: btn.sub_type || 'url',
          index: String(index),
          parameters: [{ type: 'text', text: String(btn.text || '') }]
        });
      });
    }

    templatePayload = {
      messaging_product: 'whatsapp',
      to: e164Phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en_US' },
        ...(components.length > 0 ? { components } : {})
      }
    };
  }

  // 2. Dispatch via Template First
  if (templatePayload) {
    try {
      console.log(`[WHATSAPP LIVE] Sending template '${templateName}' to +${e164Phone}`);
      const response = await axios.post(
        `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
        templatePayload,
        {
          headers: {
            Authorization: `Bearer ${WA_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      const messageId = response.data?.messages?.[0]?.id;
      console.log(`[WHATSAPP SUCCESS] Template '${templateName}' dispatched: ${messageId}`);
      return { success: true, mode: 'live_template', templateName, phone: e164Phone, messageId };
    } catch (templateErr) {
      const metaError = templateErr.response?.data?.error;
      console.warn(`[WHATSAPP TEMPLATE NOTE] Template '${templateName}' was not accepted by Meta:`, metaError?.message || templateErr.message);

      // If template fails (e.g. template pending approval or parameter mismatch), try fallback text
      // if recipient has an active 24h conversational session
      if (fallbackText) {
        try {
          console.log(`[WHATSAPP FALLBACK] Attempting session text message to +${e164Phone}`);
          const textRes = await axios.post(
            `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
            {
              messaging_product: 'whatsapp',
              to: e164Phone,
              type: 'text',
              text: { body: fallbackText }
            },
            {
              headers: {
                Authorization: `Bearer ${WA_TOKEN}`,
                'Content-Type': 'application/json'
              },
              timeout: 10000
            }
          );
          return { success: true, mode: 'live_text_fallback', phone: e164Phone, messageId: textRes.data?.messages?.[0]?.id };
        } catch (textErr) {
          console.warn('[WHATSAPP TEXT FALLBACK ERROR]', textErr.response?.data?.error?.message || textErr.message);
        }
      }

      return {
        success: false,
        mode: 'failed',
        error: metaError?.message || templateErr.message,
        code: metaError?.code
      };
    }
  }

  // 3. Raw Text Dispatch (used when no template configured)
  try {
    const textRes = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: e164Phone,
        type: 'text',
        text: { body: fallbackText }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return { success: true, mode: 'live_text', phone: e164Phone, messageId: textRes.data?.messages?.[0]?.id };
  } catch (err) {
    console.warn('[WHATSAPP API ERROR]', err.response?.data?.error?.message || err.message);
    return { success: false, mode: 'failed', error: err.response?.data?.error?.message || err.message };
  }
};

/**
 * 1. Sends an automated AWB tracking & parcel dispatch notification via WhatsApp Template.
 * Template positional parameters:
 * {{1}} Receiver Name
 * {{2}} Shipment ID
 * {{3}} Carrier Name
 * {{4}} AWB Code
 * {{5}} Live Tracking URL
 */
const sendDispatchTrackingWhatsApp = async ({ phone, receiverName, shipmentId, carrierName, awbCode, trackUrl, description }) => {
  const name = receiverName || 'Customer';
  const carrier = carrierName || 'Courier Partner';
  const awb = awbCode || 'Assigned';
  const url = trackUrl || `https://securekaro.in/track?id=${shipmentId}`;

  const fallbackText =
    `🚚 *SecureKaro — Parcel Dispatched!*\n\n` +
    `Hello ${name}! 👋\n\n` +
    `Your order *${shipmentId}*${description ? ` (${description})` : ''} has been dispatched with courier partner *${carrier}*.\n\n` +
    `📦 *Carrier:* ${carrier}\n` +
    `🔢 *AWB / Tracking Code:* ${awb}\n` +
    `🛡️ *Protection Status:* Payment Secured Under Verified Delivery\n\n` +
    `📍 *Live Real-Time Tracking:*\n${url}\n\n` +
    `_Your payment remains safely protected until you inspect and confirm delivery._`;

  return sendWhatsAppMessage({
    phone,
    templateName: TEMPLATES.AWB_DISPATCH,
    parameters: [name, shipmentId, carrier, awb, url],
    fallbackText
  });
};

/**
 * 2. Sends a shipment booked confirmation via WhatsApp Template.
 * Template positional parameters:
 * {{1}} Receiver Name
 * {{2}} Shipment ID
 * {{3}} Carrier Name
 * {{4}} AWB Code
 * {{5}} Estimated Delivery (ETA)
 */
const sendBookingConfirmationWhatsApp = async ({ phone, receiverName, shipmentId, carrierName, awbCode, eta }) => {
  const name = receiverName || 'Customer';
  const carrier = carrierName || 'Courier Partner';
  const awb = awbCode || 'Pending Pickup';
  const deliveryEta = eta || '3-5 Business Days';

  const fallbackText =
    `✅ *SecureKaro — Shipment Booked!*\n\n` +
    `Hello ${name}!\n\n` +
    `Your shipment has been booked:\n` +
    `📦 *Shipment ID:* ${shipmentId}\n` +
    `🚚 *Carrier:* ${carrier}\n` +
    `📬 *AWB Code:* ${awb}\n` +
    `⏱️ *Estimated Delivery:* ${deliveryEta}\n\n` +
    `Track your parcel anytime on SecureKaro.\n` +
    `_Your payment is protected under verified delivery sign-off._`;

  return sendWhatsAppMessage({
    phone,
    templateName: TEMPLATES.BOOKING,
    parameters: [name, shipmentId, carrier, awb, deliveryEta],
    fallbackText
  });
};

/**
 * 3. Sends a delivery confirmation sign-off OTP via WhatsApp Template.
 * Template positional parameters:
 * {{1}} Receiver Name
 * {{2}} Shipment ID
 * {{3}} 6-digit OTP Code
 */
const sendDeliveryOtpWhatsApp = async ({ phone, receiverName, shipmentId, otp, isReplacement }) => {
  const name = receiverName || 'Customer';
  const parcelType = isReplacement ? 'Replacement Parcel' : 'Parcel';

  const fallbackText =
    `🔐 *SecureKaro — Delivery Verification OTP*\n\n` +
    `Hello ${name}! 👋\n\n` +
    `Your OTP for confirming delivery of *${parcelType} #${shipmentId}* is:\n\n` +
    `*${otp}*\n\n` +
    `⏱️ Valid for *10 minutes*.\n` +
    `⚠️ Please enter this OTP on the delivery verification screen ONLY after physically inspecting your package.\n\n` +
    `_Powered by SecureKaro Delivery Protection_`;

  return sendWhatsAppMessage({
    phone,
    templateName: TEMPLATES.DELIVERY_OTP,
    parameters: [name, `${parcelType} #${shipmentId}`, String(otp)],
    fallbackText
  });
};

/**
 * 4. Autonomous NDR (Non-Delivery Report) Resolution Alert via WhatsApp Template.
 * Template positional parameters:
 * {{1}} Receiver Name
 * {{2}} Shipment ID
 * {{3}} Carrier Name
 * {{4}} Courier NDR Reason
 * {{5}} 1-Click Resolution URL
 */
const sendNdrResolutionWhatsApp = async ({ phone, receiverName, shipmentId, carrierName, awbCode, ndrReason, resolutionUrl }) => {
  const name = receiverName || 'Customer';
  const carrier = carrierName || 'Courier Partner';
  const reason = ndrReason || 'Customer was unavailable / Door locked';
  const url = resolutionUrl || `https://securekaro.in/ndr?id=${shipmentId}`;

  const fallbackText =
    `⚠️ *Delivery Attempt Notice — SecureKaro Delivery Shield*\n\n` +
    `Hello ${name}! 👋\n\n` +
    `The courier executive from *${carrier}* attempted to deliver your order *${shipmentId}* (AWB: ${awbCode || 'Pending'}) today, but the delivery could not be completed.\n\n` +
    `📌 *Courier Reason:* "${reason}"\n\n` +
    `To prevent this parcel from being returned to the seller (RTO), please choose your preferred delivery preference in 1-click:\n\n` +
    `👉 *Tap to Reschedule or Update Address:*\n${url}\n\n` +
    `_Your parcel & payment are protected under SecureKaro Verified Delivery Protection._`;

  return sendWhatsAppMessage({
    phone,
    templateName: TEMPLATES.NDR,
    parameters: [name, shipmentId, carrier, reason, url],
    fallbackText
  });
};

/**
 * 5. Sends a payment link via WhatsApp Template.
 * Template positional parameters:
 * {{1}} Receiver Name
 * {{2}} Shipment ID
 * {{3}} Amount (₹)
 * {{4}} Payment URL
 */
const sendPaymentLinkWhatsApp = async ({ phone, receiverName, shipmentId, amount, description, linkUrl }) => {
  const name = receiverName || 'Customer';
  const formattedAmount = `₹${Number(amount || 0).toLocaleString('en-IN')}`;
  const url = linkUrl || `https://securekaro.in/pay/${shipmentId}`;

  const fallbackText =
    `🛡️ *SecureKaro Order Payment Request*\n\n` +
    `Hello ${name}! 👋\n\n` +
    `*Shipment ID:* ${shipmentId}\n` +
    `*Item:* ${description || 'Parcel'}\n` +
    `*Amount to Pay:* ${formattedAmount}\n\n` +
    `Your order is protected under *SecureKaro Delivery Verification*. Funds are safely disbursed only after delivery confirmation.\n\n` +
    `💳 *Pay Securely Here:*\n${url}\n\n` +
    `_Powered by SecureKaro Delivery Protection_`;

  return sendWhatsAppMessage({
    phone,
    templateName: TEMPLATES.PAYMENT,
    parameters: [name, shipmentId, formattedAmount, url],
    fallbackText
  });
};

/**
 * 6. Sends reverse courier assignment notification via WhatsApp Template.
 * Template positional parameters:
 * {{1}} Shipment ID
 * {{2}} Carrier Name
 * {{3}} Return Tracking ID / AWB
 * {{4}} Pickup Slot / Window
 */
const sendReverseCourierAssignedWhatsApp = async ({ phone, shipmentId, carrierName, trackingId, pickupWindow }) => {
  const carrier = carrierName || 'Courier Partner';
  const awb = trackingId || 'Assigned';
  const slot = pickupWindow || 'Tomorrow (10:00 AM - 2:00 PM)';

  const fallbackText =
    `🔄 *SecureKaro: Return Approved!*\n\n` +
    `Your reverse courier has been automatically booked for Shipment *#${shipmentId}* with *${carrier}*.\n\n` +
    `📦 *Carrier:* ${carrier}\n` +
    `🔢 *Tracking ID:* ${awb}\n` +
    `⏱️ *Scheduled Pickup Window:* ${slot}\n\n` +
    `Please keep the item safely packed and sealed for collection.\n` +
    `_Your refund is safeguarded under SecureKaro buyer protection._`;

  return sendWhatsAppMessage({
    phone,
    templateName: TEMPLATES.REVERSE_AWB,
    parameters: [shipmentId, carrier, awb, slot],
    fallbackText
  });
};

/**
 * 7. Sends photo review mandatory notice via WhatsApp Template.
 */
const sendPhotoReviewChoiceWhatsApp = async ({ phone, shipmentId, receiverName, carrierSlug, awbCode }) => {
  const name = receiverName || 'Customer';
  const courier = carrierSlug ? carrierSlug.toUpperCase() : 'DELHIVERY';
  const awb = awbCode || 'Pending';

  const fallbackText =
    `Hi ${name}! 👋\n\n` +
    `📦 *SecureKaro: Shipment #${shipmentId}* has been booked.\n` +
    `🚚 *Carrier:* ${courier} | AWB: ${awb}\n\n` +
    `📸 *Safety Note:* Parcel & product photo verification is mandatory for this shipment before courier dispatch for your security.\n` +
    `_Your payment remains secured under verified delivery protection._`;

  return sendWhatsAppMessage({
    phone,
    templateName: TEMPLATES.PHOTO_REVIEW,
    parameters: [name, shipmentId, courier, awb],
    fallbackText
  });
};

/**
 * 8. Sends payout released notification via WhatsApp Template.
 */
const sendPayoutReleasedWhatsApp = async ({ phone, senderName, shipmentId, amount, netPayout, method }) => {
  const name = senderName || 'Merchant';
  const orderAmount = `₹${Number(amount || 0).toLocaleString('en-IN')}`;
  const released = `₹${Number(netPayout || amount || 0).toLocaleString('en-IN')}`;
  const destination = method || 'Merchant Wallet Balance';

  const fallbackText =
    `💰 *SecureKaro — Payout Released!*\n\n` +
    `Hello ${name}! 🎉\n\n` +
    `Order *#${shipmentId}* delivery has been confirmed and verified.\n\n` +
    `💵 *Order Value:* ${orderAmount}\n` +
    `✅ *Net Payout Released:* ${released}\n` +
    `🏦 *Credited To:* ${destination}\n\n` +
    `_Thank you for shipping with SecureKaro!_`;

  return sendWhatsAppMessage({
    phone,
    templateName: TEMPLATES.PAYOUT,
    parameters: [name, shipmentId, orderAmount, released, destination],
    fallbackText
  });
};

module.exports = {
  sendWhatsAppMessage,
  sendPaymentLinkWhatsApp,
  sendBookingConfirmationWhatsApp,
  sendDispatchTrackingWhatsApp,
  sendReverseCourierAssignedWhatsApp,
  sendPhotoReviewChoiceWhatsApp,
  sendDeliveryOtpWhatsApp,
  sendPayoutReleasedWhatsApp,
  sendNdrResolutionWhatsApp
};
