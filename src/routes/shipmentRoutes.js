const express = require('express');
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
  try { return require(`../${type}/${name}`); } catch(e) {}
  return require(`./${name}`);
}

const { 
  getShipments, 
  getShipmentById, 
  createShipment, 
  fundShipment, 
  dispatchShipment,
  releaseShipment,
  cancelShipment,
  markUndelivered,
  requestReturn,
  approveReturn,
  confirmReturnReceived,
  generatePaymentLink,
  confirmDeliveryHandler,
  closeReturnRequestHandler,
  closeReturnWindowHandler,
  simulateDelivered,
  toggleReturnOption,
  getSupplierReturnOrders,
  getReceiverReturnOrders,
  getSupplierGatewayQuota,
  optInPhotoReview,
  refusePhotoReview,
  uploadParcelPhoto,
  offerDiscount,
  respondDiscount,
  approveReplacementHandler,
  rejectReplacementHandler,
  dispatchReplacementHandler,
  confirmReplacementDeliveryHandler,
  getQrLabel,
  getReplacementQrLabel,
  publicQrGetInfo,
  publicQrSendOtp,
  publicQrConfirm,
  exportUserShipments,
  quoteCodFees,
  publicPayShipment,
  paymentWebhookHandler
} = loadMod('controllers', 'shipmentController');
const { createPaymentSessionForShipment } = loadMod('controllers', 'youpiWebhookController');
const { getSupportedCouriersList, getPincodeInfo } = loadMod('services', 'carrierRateService');
const { protect } = loadMod('middleware', 'auth');

const router = express.Router();

// ── Public Courier Directory & Serviceability (Cached 24h, zero PII) ────────
router.get('/couriers', async (req, res) => {
  try {
    const couriers = await getSupportedCouriersList();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ success: true, count: couriers.length, couriers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve courier services', details: err.message });
  }
});

router.get('/serviceability/pincode/:pincode', async (req, res) => {
  try {
    const info = getPincodeInfo(req.params.pincode);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json({ success: true, serviceability: info });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check serviceability', details: err.message });
  }
});

// ── Public Payment & Gateway Webhooks (no login required) ───────────────────
router.route('/public/pay/:id')
  .post(publicPayShipment);

router.route('/public/youpi-link/:id')
  .post(createPaymentSessionForShipment);

router.route('/webhook/payment')
  .post(paymentWebhookHandler);

router.route('/:id/generate-youpi-link')
  .post(protect, createPaymentSessionForShipment);

router.route('/')
  .get(protect, getShipments)
  .post(protect, createShipment);

router.route('/quote-cod')
  .post(protect, quoteCodFees);

router.route('/export')
  .get(protect, exportUserShipments);

router.route('/returns/supplier')
  .get(protect, getSupplierReturnOrders);

router.route('/returns/receiver')
  .get(protect, getReceiverReturnOrders);

router.route('/gateway-fee-status')
  .get(protect, getSupplierGatewayQuota);

// ── Public Delivery Sign-Off (no login required) ───────────────────────────
// STEP 0: Preview parcel details & masked phone hint
router.route('/public/qr-info/:token')
  .get(publicQrGetInfo);
router.route('/public/qr-info')
  .get(publicQrGetInfo);

// STEP 1: Verify phone → send SMS OTP
router.route('/public/send-otp/:token')
  .post(publicQrSendOtp);
router.route('/public/send-otp')
  .post(publicQrSendOtp);

// STEP 2: Verify OTP + action (confirm | return)
router.route('/public/qr-confirm/:token')
  .post(publicQrConfirm);
router.route('/public/qr-confirm')
  .post(publicQrConfirm);

router.route('/:id')
  .get(protect, getShipmentById);

router.route('/:id/payment-link')
  .post(protect, generatePaymentLink);

router.route('/:id/fund')
  .post(protect, fundShipment);

router.route('/:id/dispatch')
  .put(protect, dispatchShipment);

router.route('/:id/release')
  .put(protect, releaseShipment);

router.route('/:id/confirm-delivery')
  .put(protect, confirmDeliveryHandler);

router.route('/:id/cancel')
  .put(protect, cancelShipment);

router.route('/:id/undelivered')
  .put(protect, markUndelivered);

router.route('/:id/return-request')
  .put(protect, requestReturn);

router.route('/:id/return-close')
  .put(protect, closeReturnRequestHandler);

router.route('/:id/return-window-close')
  .put(protect, closeReturnWindowHandler);

router.route('/:id/return-approve')
  .put(protect, approveReturn);

router.route('/:id/return-confirm')
  .put(protect, confirmReturnReceived);

router.route('/:id/return-offer-discount')
  .put(protect, offerDiscount);

router.route('/:id/return-respond-discount')
  .put(protect, respondDiscount);

router.route('/:id/return-approve-replacement')
  .put(protect, approveReplacementHandler);

router.route('/:id/return-reject-replacement')
  .put(protect, rejectReplacementHandler);

router.route('/:id/return-dispatch-replacement')
  .put(protect, dispatchReplacementHandler);

router.route('/:id/return-confirm-replacement')
  .put(protect, confirmReplacementDeliveryHandler);

router.route('/:id/toggle-return')
  .put(protect, toggleReturnOption);

router.route('/:id/simulate-delivered')
  .put(protect, simulateDelivered);

router.route('/:id/photo-review-pay')
  .post(protect, optInPhotoReview);

router.route('/:id/photo-review-refuse')
  .post(protect, refusePhotoReview);

router.route('/:id/parcel-photo')
  .put(protect, uploadParcelPhoto);

// ── In-Box QR Label (seller prints & puts inside parcel) ──────────────────
router.route('/:id/qr-label')
  .get(protect, getQrLabel);

// ── Replacement In-Box QR Label (seller prints & puts inside replacement parcel) ──
router.route('/:id/replacement-qr-label')
  .get(protect, getReplacementQrLabel);

module.exports = router;
