/**
 * YouPI-PG Webhook Controller
 * ============================
 * Handles inbound payment event webhooks from the self-hosted YouPI-PG gateway.
 *
 * Security layers implemented:
 *  1. Raw body capture BEFORE any JSON parsing (required for HMAC verification)
 *  2. HMAC-SHA256 signature verification (timing-safe)
 *  3. Amount cross-verification (webhook paise == shipment rupees × 100)
 *  4. Idempotency guard (processed event IDs stored in-memory with 24h TTL)
 *  5. Replay attack prevention (event timestamps validated within ±10 min window)
 *  6. IP allowlist check (only accept from YOUPI_GATEWAY_IP if configured)
 *  7. No PII logged — only shipment ID and event type
 */

const Shipment = require('../models/Shipment');
const User = require('../models/User');
const escrow = require('../services/escrow');
const { verifyWebhookSignature, verifyAmountMatch } = require('../services/youpiPaymentService');
const { grantPrepaymentCashback } = require('../services/rewardService');
const { createNotification } = require('../services/notification');
const { recordTransaction } = require('../services/walletService');

// ── Idempotency Store (in-memory, 24h TTL) ─────────────────────────────────
// In production, swap this for a Redis SET with TTL for multi-instance safety.
const processedEventIds = new Map(); // eventId → timestamp

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const isEventProcessed = (eventId) => {
  if (!eventId) return false;
  const ts = processedEventIds.get(eventId);
  if (!ts) return false;
  if (Date.now() - ts > IDEMPOTENCY_TTL_MS) {
    processedEventIds.delete(eventId);
    return false;
  }
  return true;
};

const markEventProcessed = (eventId) => {
  if (eventId) processedEventIds.set(eventId, Date.now());
  // Periodic cleanup to avoid memory leak
  if (processedEventIds.size > 50000) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [id, ts] of processedEventIds.entries()) {
      if (ts < cutoff) processedEventIds.delete(id);
    }
  }
};

// ── IP Allowlist Guard ──────────────────────────────────────────────────────
const YOUPI_ALLOWED_IPS = process.env.YOUPI_GATEWAY_IPS
  ? process.env.YOUPI_GATEWAY_IPS.split(',').map(ip => ip.trim()).filter(Boolean)
  : []; // Empty = allow all (dev mode). Set this in production!

const isAllowedIp = (req) => {
  if (YOUPI_ALLOWED_IPS.length === 0) return true; // Dev: no restriction
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
  return YOUPI_ALLOWED_IPS.some(allowed => ip === allowed || ip.endsWith(allowed));
};

// ── Replay Window Guard (±10 minutes) ──────────────────────────────────────
const REPLAY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const isWithinReplayWindow = (eventTimestamp) => {
  if (!eventTimestamp) return true; // No timestamp = don't enforce (legacy)
  const ts = new Date(eventTimestamp).getTime();
  if (isNaN(ts)) return true;
  return Math.abs(Date.now() - ts) <= REPLAY_WINDOW_MS;
};

/**
 * @route   POST /api/v1/youpi/webhook
 * @desc    Receive and process YouPI-PG payment events (SUCCESS, FAILED, EXPIRED)
 * @access  YouPI-PG gateway only (HMAC-verified)
 */
const handleWebhook = async (req, res) => {
  try {
    // ── 1. IP Allowlist Check ─────────────────────────────────────────────
    if (!isAllowedIp(req)) {
      console.warn(`[YouPI Webhook] Rejected: IP not in allowlist (${req.socket.remoteAddress})`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // ── 2. HMAC Signature Verification ───────────────────────────────────
    // req.rawBody is attached by the raw body middleware in youpiRoutes.js
    const rawBody = req.rawBody;
    if (!rawBody) {
      console.error('[YouPI Webhook] No raw body available — body middleware misconfigured');
      return res.status(400).json({ error: 'Bad request: missing body' });
    }

    const signature = req.headers['x-youpi-signature'] || req.headers['x-signature'] || '';
    if (!verifyWebhookSignature(rawBody, signature)) {
      console.warn('[YouPI Webhook] HMAC signature verification FAILED — rejecting');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    // ── 3. Parse and validate payload ────────────────────────────────────
    let payload;
    try {
      payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    const { event, paymentId, orderId, amountPaise, status, completedAt, eventId, timestamp } = payload;

    if (!event || !orderId) {
      return res.status(400).json({ error: 'Missing required fields: event, orderId' });
    }

    // ── 4. Replay Attack Prevention ───────────────────────────────────────
    if (!isWithinReplayWindow(timestamp || completedAt)) {
      console.warn(`[YouPI Webhook] Replay detected: event timestamp out of ±10 min window for orderId=${orderId}`);
      return res.status(400).json({ error: 'Webhook timestamp out of acceptable window' });
    }

    // ── 5. Idempotency Guard ──────────────────────────────────────────────
    const dedupKey = eventId || `${paymentId}:${event}`;
    if (isEventProcessed(dedupKey)) {
      console.log(`[YouPI Webhook] Duplicate event ignored: ${dedupKey}`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    console.log(`[YouPI Webhook] Processing event=${event} orderId=${orderId} paymentId=${paymentId}`);

    // ── 6. Route to event handler ─────────────────────────────────────────
    switch (event.toUpperCase()) {
      case 'SUCCESS':
      case 'PAYMENT.SUCCESS':
        await handlePaymentSuccess({ orderId, paymentId, amountPaise, completedAt });
        break;

      case 'FAILED':
      case 'PAYMENT.FAILED':
      case 'EXPIRED':
      case 'PAYMENT.EXPIRED':
        await handlePaymentFailed({ orderId, paymentId, event });
        break;

      default:
        // Log unknown events but still acknowledge (don't retry)
        console.log(`[YouPI Webhook] Unknown event type: ${event} — acknowledged without action`);
    }

    // Mark as processed AFTER successful handling
    markEventProcessed(dedupKey);

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('[YouPI Webhook] Unhandled error:', err.message);
    // Return 200 to prevent gateway from retrying a server bug
    return res.status(200).json({ received: true, error: 'Internal processing error' });
  }
};

// ── Event Handler: Payment SUCCESS ──────────────────────────────────────────
async function handlePaymentSuccess({ orderId, paymentId, amountPaise, completedAt }) {
  // Find shipment by ID
  const shipment = await Shipment.findOne({
    shipmentId: orderId.toUpperCase().trim()
  }).populate('senderId receiverId');

  if (!shipment) {
    console.warn(`[YouPI Webhook] SUCCESS: No shipment found for orderId=${orderId}`);
    return;
  }

  // Guard: Don't process if already confirmed (idempotency at DB level)
  if (shipment.youpiPaymentConfirmed === true) {
    console.log(`[YouPI Webhook] SUCCESS: Already confirmed for ${orderId} — skipping`);
    return;
  }

  // ── Amount Cross-Verification (anti-tamper) ──────────────────────────────
  // SECURITY: Compare webhook paise with shipment's stored rupee amount
  if (amountPaise && !verifyAmountMatch(amountPaise, shipment.amount)) {
    console.error(
      `[YouPI Webhook] AMOUNT MISMATCH for ${orderId}: ` +
      `webhook=${amountPaise} paise, expected=${Math.round(shipment.amount * 100)} paise — REJECTING`
    );
    // Don't release escrow — this is a potential fraud attempt
    return;
  }

  // ── Update shipment to mark payment confirmed ────────────────────────────
  shipment.paymentMode = 'prepaid_youpi';
  shipment.youpiPaymentId = paymentId;
  shipment.youpiPaymentConfirmed = true;
  shipment.youpiConfirmedAt = completedAt ? new Date(completedAt) : new Date();
  await shipment.save();

  console.log(`[YouPI Webhook] Payment confirmed for shipment ${orderId} via YouPI (paymentId: ${paymentId})`);

  // ── Execute standard order payment & courier booking engine ───────────────
  try {
    const { executeOrderPaymentAndCourierBooking } = require('./shipmentController');
    if (typeof executeOrderPaymentAndCourierBooking === 'function') {
      await executeOrderPaymentAndCourierBooking(shipment, {
        transactionRef: paymentId,
        gateway: 'youpi_upi'
      });
      console.log(`[YouPI Webhook] Courier booked & escrow funded successfully for ${orderId}`);
    }
  } catch (bookingErr) {
    console.error(`[YouPI Webhook] Courier booking/escrow warning for ${orderId}: ${bookingErr.message}`);
    // Non-fatal fallback: shipment is already saved with paymentMode and confirmed status
  }
}

// ── Event Handler: Payment FAILED / EXPIRED ─────────────────────────────────
async function handlePaymentFailed({ orderId, paymentId, event }) {
  const shipment = await Shipment.findOne({
    shipmentId: orderId.toUpperCase().trim()
  }).populate('receiverId');

  if (!shipment) {
    console.warn(`[YouPI Webhook] ${event}: No shipment found for orderId=${orderId}`);
    return;
  }

  // Only act if shipment is still awaiting payment
  if (shipment.youpiPaymentConfirmed === true) {
    console.log(`[YouPI Webhook] ${event}: Payment was already confirmed for ${orderId} — ignoring failure`);
    return;
  }

  // Reset YouPI payment ID so a new session can be created on retry
  shipment.youpiPaymentId = null;
  shipment.youpiPaymentConfirmed = false;
  await shipment.save();

  console.log(`[YouPI Webhook] Payment ${event} for shipment ${orderId}`);

  // ── Notify buyer that payment failed ────────────────────────────────────
  try {
    const buyer = shipment.receiverId;
    if (buyer && buyer._id) {
      const isExpired = event.toUpperCase().includes('EXPIRED');
      await createNotification(
        buyer._id,
        'payments',
        `${isExpired ? '⏰ Payment Expired' : '❌ Payment Failed'}: ${shipment.shipmentId}`,
        `Your UPI payment for order #${shipment.shipmentId} (₹${shipment.amount}) ` +
        (isExpired
          ? 'has expired. The payment window timed out. Please retry the payment link.'
          : 'could not be processed. Please try again using the payment link.'),
        'payment'
      );
    }
  } catch (notifyErr) {
    console.warn(`[YouPI Webhook] Buyer notification warning for ${orderId}: ${notifyErr.message}`);
  }
}

/**
 * @route   GET /api/v1/youpi/payment-status/:paymentId
 * @desc    Poll YouPI payment status (for frontend polling fallback)
 * @access  Authenticated users only
 */
const getPaymentStatusForShipment = async (req, res) => {
  try {
    const { shipmentId } = req.params;
    const userId = req.user?.id;

    if (!shipmentId) {
      return res.status(400).json({ error: 'shipmentId is required' });
    }

    const shipment = await Shipment.findOne({
      shipmentId: shipmentId.toUpperCase().trim()
    }).select('shipmentId youpiPaymentId youpiPaymentConfirmed paymentMode amount senderId receiverId');

    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Only sender or receiver can query payment status
    const isParticipant =
      String(shipment.senderId) === String(userId) ||
      String(shipment.receiverId) === String(userId);

    if (!isParticipant) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.status(200).json({
      shipmentId: shipment.shipmentId,
      paymentMode: shipment.paymentMode,
      youpiPaymentId: shipment.youpiPaymentId || null,
      confirmed: shipment.youpiPaymentConfirmed === true,
      amount: shipment.amount
    });

  } catch (err) {
    console.error('[YouPI] getPaymentStatusForShipment error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * @route   POST /api/v1/youpi/session/:shipmentId
 * @desc    Generate or retrieve an active YouPI UPI payment session for a shipment
 * @access  Public / Authenticated
 */
const createPaymentSessionForShipment = async (req, res) => {
  try {
    const shipmentId = (req.params.shipmentId || req.params.id || req.body.shipmentId || '').toUpperCase().trim();
    if (!shipmentId) {
      return res.status(400).json({ error: 'Shipment ID is required' });
    }

    const shipment = await Shipment.findOne({ shipmentId });
    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    // Check if already paid
    if (shipment.receiverPaymentDone || shipment.youpiPaymentConfirmed) {
      return res.status(200).json({
        alreadyPaid: true,
        message: 'Payment has already been confirmed for this shipment',
        shipmentId: shipment.shipmentId,
        paymentMode: shipment.paymentMode
      });
    }

    const { createPaymentSession } = require('../services/youpiPaymentService');
    const returnUrl = req.body.returnUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/pay/${shipment.shipmentId}?completed=true`;

    const session = await createPaymentSession({
      shipmentId: shipment.shipmentId,
      amount: shipment.amount,
      returnUrl,
      customerPhone: shipment.receiverPhone,
      customerName: shipment.receiverName
    });

    // Save session reference to shipment
    shipment.youpiPaymentId = session.paymentId;
    shipment.paymentMode = 'prepaid_youpi';
    await shipment.save();

    return res.status(200).json({
      success: true,
      shipmentId: shipment.shipmentId,
      paymentId: session.paymentId,
      checkoutUrl: session.checkoutUrl,
      amount: shipment.amount,
      status: session.status
    });

  } catch (err) {
    console.error('[YouPI] createPaymentSessionForShipment error:', err);
    return res.status(500).json({ error: 'Failed to create payment session', details: err.message });
  }
};

/**
 * @route   POST /api/v1/youpi/simulate-payment/:shipmentId
 * @desc    Simulates a verified YouPI payment event (useful in dev/test)
 * @access  Public in dev, Admin in production
 */
const simulatePaymentSuccess = async (req, res) => {
  if (process.env.NODE_ENV === 'production' && req.user?.role !== 'Admin') {
    return res.status(403).json({ error: 'Simulation only available in development mode' });
  }

  const shipmentId = (req.params.shipmentId || '').toUpperCase().trim();
  const shipment = await Shipment.findOne({ shipmentId });
  if (!shipment) return res.status(404).json({ error: 'Shipment not found' });

  const paymentId = shipment.youpiPaymentId || `sim_${Date.now()}`;
  await handlePaymentSuccess({
    orderId: shipment.shipmentId,
    paymentId,
    amountPaise: Math.round(shipment.amount * 100),
    completedAt: new Date().toISOString()
  });

  const updated = await Shipment.findOne({ shipmentId });
  return res.status(200).json({
    success: true,
    message: `Simulated YouPI payment success for ${shipmentId}`,
    shipment: updated
  });
};

module.exports = {
  handleWebhook,
  getPaymentStatusForShipment,
  createPaymentSessionForShipment,
  simulatePaymentSuccess
};
