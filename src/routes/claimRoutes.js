const express = require('express');
const { fileClaim, getClaimByShipmentId } = require('../controllers/claimController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.route('/')
  .post(protect, fileClaim);

router.route('/:shipmentId')
  .get(protect, getClaimByShipmentId);

module.exports = router;
