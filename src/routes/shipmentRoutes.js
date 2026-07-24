const express = require('express');
const path = require('path');
const fs = require('fs');

function loadModule(target) {
  const candidates = [
    path.resolve(__dirname, '..', 'controllers', target),
    path.resolve(__dirname, 'controllers', target),
    path.resolve(__dirname, target),
    path.resolve(process.cwd(), 'src', 'controllers', target),
    path.resolve(process.cwd(), 'controllers', target),
    path.resolve(process.cwd(), target)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c + '.js')) return require(c + '.js');
    if (fs.existsSync(c)) return require(c);
  }
  try { return require(`../controllers/${target}`); } catch(e) {}
  try { return require(`./controllers/${target}`); } catch(e) {}
  return require(`./${target}`);
}

const shipmentController = loadModule('shipmentController');

const router = express.Router();
router.post('/', shipmentController.createShipment);
router.get('/', shipmentController.getShipments);
router.get('/:id', shipmentController.getShipmentById);
router.post('/:id/confirm-receipt', shipmentController.confirmReceipt);

module.exports = router;
