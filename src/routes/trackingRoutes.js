const express = require('express');
const { handleWebhook } = require('../controllers/trackingController');

const router = express.Router();

// Public webhook route for simulated status notifications
router.post('/webhook/carrier-tracking', handleWebhook);
router.post('/webhook/shiprocket', handleWebhook); // Backwards compatibility

module.exports = router;
