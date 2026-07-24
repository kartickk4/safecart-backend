const express = require('express');
const { 
  getShipments, 
  getShipmentById, 
  createShipment, 
  fundShipment, 
  releaseShipment 
} = require('../controllers/shipmentController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.route('/')
  .get(protect, getShipments)
  .post(protect, createShipment);

router.route('/:id')
  .get(protect, getShipmentById);

router.route('/:id/fund')
  .post(protect, fundShipment);

router.route('/:id/release')
  .put(protect, releaseShipment);

module.exports = router;
