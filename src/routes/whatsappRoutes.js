const express = require('express');
const router = express.Router();

/**
 * GET /api/v1/whatsapp/webhook
 * Meta calls this to verify the webhook URL during setup.
 * It sends: hub.mode=subscribe, hub.verify_token, hub.challenge
 * We must echo back hub.challenge if the verify_token matches.
 */
router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'securekaro_wh_2026';

  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
    console.log('[WhatsApp Webhook] Verification successful ✅');
    return res.status(200).send(challenge);
  }

  console.warn('[WhatsApp Webhook] Verification failed — token mismatch');
  return res.sendStatus(403);
});

const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

function loadModel(name) {
  const p1 = path.resolve(__dirname, '..', 'models', name);
  const p2 = path.resolve(process.cwd(), 'src', 'models', name);
  if (fs.existsSync(p1 + '.js')) return require(p1);
  if (fs.existsSync(p2 + '.js')) return require(p2);
  try { return require(`../models/${name}`); } catch(e) {}
  return null;
}

const Shipment = loadModel('Shipment');

/**
 * Helper to dispatch outbound WhatsApp replies
 */
const sendWhatsAppReply = async (toPhone, replyBody) => {
  const WA_TOKEN = process.env.WHATSAPP_TOKEN;
  const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.warn('[WhatsApp Bot] Outbound message skipped: WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set.');
    return;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'text',
        text: { body: replyBody }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    console.log(`[WhatsApp Bot Reply] Successfully sent to +${toPhone}`);
  } catch (err) {
    console.error(`[WhatsApp Bot Reply Error] Failed to send to +${toPhone}:`, err.response?.data?.error?.message || err.message);
  }
};

/**
 * Validates Meta WhatsApp Webhook X-Hub-Signature-256 HMAC
 */
const verifyMetaSignature = (req) => {
  const signature = req.headers['x-hub-signature-256'];
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return true; // Pass if app secret not configured in dev
  if (!signature || !signature.startsWith('sha256=')) return false;

  try {
    const signatureHash = signature.slice(7);
    const expectedHash = crypto
      .createHmac('sha256', appSecret)
      .update(req.rawBody || JSON.stringify(req.body))
      .digest('hex');

    const sigBuf = Buffer.from(signatureHash, 'hex');
    const expBuf = Buffer.from(expectedHash, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (e) {
    return false;
  }
};

/**
 * POST /api/v1/whatsapp/webhook
 * Meta sends incoming buyer messages and delivery status updates here.
 * Always respond 200 immediately to avoid Meta retrying.
 */
router.post('/webhook', async (req, res) => {
  if (!verifyMetaSignature(req)) {
    console.warn('[WhatsApp Webhook] Rejected: Invalid X-Hub-Signature-256 HMAC');
    return res.status(403).json({ error: 'Invalid webhook signature' });
  }

  // Always acknowledge immediately (Meta requires < 20s response)
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from; // e.g. "916289817321"
    const text = (message.text?.body || '').trim();
    const lower = text.toLowerCase();
    const raw10Digits = from.replace(/\D/g, '').slice(-10);

    console.log(`[WhatsApp Incoming] From +${from}: "${text}"`);

    // 1. Keyword: Track or Status
    if (lower === 'track' || lower === 'status' || lower.startsWith('track ')) {
      let shipment = null;
      if (Shipment) {
        shipment = await Shipment.findOne({
          $or: [
            { receiverPhone: new RegExp(raw10Digits) },
            { senderPhone: new RegExp(raw10Digits) }
          ]
        }).sort({ createdAt: -1 });
      }

      if (shipment) {
        const reply = 
          `📦 *SecureKaro Parcel Status*\n\n` +
          `• *Order ID:* ${shipment.shipmentId}\n` +
          `• *Status:* ${shipment.status || 'In Transit'}\n` +
          `• *Courier:* ${shipment.carrierSlug ? shipment.carrierSlug.toUpperCase() : 'Delhivery'}\n` +
          `• *AWB Code:* ${shipment.awbCode || shipment.trackingId || 'Assigned on Dispatch'}\n` +
          `• *Protected Value:* ₹${Number(shipment.amount || 0).toLocaleString('en-IN')}\n\n` +
          `🔗 *Live Real-Time Tracking:*\nhttps://securekaro.in/track?id=${shipment.shipmentId}\n\n` +
          `_Protected by SecureKaro Escrow Protocol_`;
        await sendWhatsAppReply(from, reply);
      } else {
        const reply = 
          `🔍 We could not locate an active shipment matching mobile number +${raw10Digits}.\n\n` +
          `Please provide your order tracking ID directly, e.g.:\n*TRACK SPL-1234-X*\n\n` +
          `Or track your shipment at: https://securekaro.in`;
        await sendWhatsAppReply(from, reply);
      }
      return;
    }

    // 2. Keyword: Help or Support
    if (lower === 'help' || lower === 'support' || lower === 'agent') {
      const reply = 
        `🛡️ *SecureKaro Customer Support*\n\n` +
        `We're here to protect your orders and shipments!\n\n` +
        `• *Website:* https://securekaro.in\n` +
        `• *Email:* support@securekaro.in\n` +
        `• *Dispute Redressal:* 24-hour verification window\n\n` +
        `Reply *TRACK* to check your latest parcel status.\n` +
        `Reply *MENU* to view all quick options.`;
      await sendWhatsAppReply(from, reply);
      return;
    }

    // 3. Keyword: Confirm or Delivered
    if (lower === 'confirm' || lower === 'received' || lower === 'delivered') {
      const reply = 
        `✅ *Delivery Verification*\n\n` +
        `To confirm delivery and inspect your parcel safely, open your order link or scan the secure QR label inside your package box:\n\n` +
        `🔗 https://securekaro.in\n\n` +
        `Once confirmed, the escrow protection releases the order payout to the seller.`;
      await sendWhatsAppReply(from, reply);
      return;
    }

    // 4. Default / Menu Greeting
    const defaultGreeting = 
      `👋 *Hello from SecureKaro!*\n` +
      `_India's Premier Logistics & Delivery Protection Platform_\n\n` +
      `How can we assist you today?\n\n` +
      `📦 Send *TRACK* — Check live parcel location & courier AWB\n` +
      `✅ Send *CONFIRM* — Sign off delivery & release payment\n` +
      `💬 Send *HELP* — Customer care & dispute assistance\n\n` +
      `🌐 Visit portal: https://securekaro.in`;

    await sendWhatsAppReply(from, defaultGreeting);

  } catch (err) {
    console.error('[WhatsApp Webhook] Processing error:', err.message);
  }
});

module.exports = router;
