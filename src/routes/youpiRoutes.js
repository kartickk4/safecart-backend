const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

function loadMod(type, name) {
  const candidates = [
    path.resolve(__dirname, '..', type, name),
    path.resolve(__dirname, type, name),
    path.resolve(__dirname, name),
    path.resolve(process.cwd(), 'src', type, name),
    path.resolve(process.cwd(), type, name),
    path.resolve(process.cwd(), name)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c + '.js')) return require(c + '.js');
    if (fs.existsSync(c)) return require(c);
  }
  try { return require(`../${type}/${name}`); } catch (e) {}
  return require(`./${name}`);
}

const {
  handleWebhook,
  getPaymentStatusForShipment,
  createPaymentSessionForShipment,
  simulatePaymentSuccess
} = loadMod('controllers', 'youpiWebhookController');

const { protect } = loadMod('middleware', 'auth');

// Middleware to ensure req.rawBody is captured for HMAC signature verification
const captureRawBody = (req, res, next) => {
  if (req.rawBody) return next();
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    return next();
  }
  if (typeof req.body === 'string') {
    req.rawBody = Buffer.from(req.body, 'utf8');
    return next();
  }
  if (req.body && typeof req.body === 'object') {
    req.rawBody = Buffer.from(JSON.stringify(req.body), 'utf8');
    return next();
  }
  next();
};

/**
 * @route   POST /api/v1/youpi/webhook
 * @desc    Inbound webhook receiver from YouPI-PG sovereign payment gateway
 * @access  Public (Secured via HMAC-SHA256 signature verification & IP allowlist)
 */
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  captureRawBody,
  handleWebhook
);

/**
 * @route   POST /api/v1/youpi/session/:shipmentId
 * @desc    Create or retrieve a YouPI checkout session URL for a shipment
 * @access  Public (buyers paying for order)
 */
router.post('/session/:shipmentId', createPaymentSessionForShipment);

/**
 * @route   GET /api/v1/youpi/payment-status/:shipmentId
 * @desc    Poll status of a YouPI payment for a shipment
 * @access  Private
 */
router.get('/payment-status/:shipmentId', protect, getPaymentStatusForShipment);

/**
 * @route   POST /api/v1/youpi/simulate-payment/:shipmentId
 * @desc    Development testing simulation endpoint
 * @access  Public in DEV
 */
router.post('/simulate-payment/:shipmentId', simulatePaymentSuccess);

module.exports = router;
