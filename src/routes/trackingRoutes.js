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
  try { return require(`./${type}/${name}`); } catch(e) {}
  return require(`./${name}`);
}

const { getTrackingByAwb, handleWebhook } = loadMod('controllers', 'trackingController');

const router = express.Router();

router.get('/:awb', getTrackingByAwb);
router.post('/webhook/carrier-tracking', handleWebhook);
router.post('/webhook/shiprocket', handleWebhook);

module.exports = router;
