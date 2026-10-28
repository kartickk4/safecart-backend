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
router.post('/webhook', (req, res) => {
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

    const from = message.from; // buyer's E.164 phone e.g. "919748556086"
    const text = (message.text?.body || '').toLowerCase().trim();

    console.log(`[WhatsApp Incoming] From +${from}: "${text}"`);

    // Auto-reply keywords buyers can send
    if (text === 'track' || text === 'status') {
      console.log(`[WhatsApp] Tracking request from +${from}`);
      // TODO: Look up latest shipment for this phone and send tracking link back
    } else if (text === 'return' || text === 'refund') {
      console.log(`[WhatsApp] Return request from +${from}`);
      // TODO: Initiate return process
    } else if (text === 'confirm' || text === 'received' || text === 'delivered') {
      console.log(`[WhatsApp] Delivery confirmation from +${from}`);
      // TODO: Confirm delivery and release escrow
    } else if (text === 'help') {
      console.log(`[WhatsApp] Help request from +${from}`);
      // TODO: Send help message back
    }
  } catch (err) {
    console.error('[WhatsApp Webhook] Processing error:', err.message);
  }
});

module.exports = router;
