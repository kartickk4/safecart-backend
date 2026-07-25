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

const { fileClaim, getClaimByShipmentId } = loadMod('controllers', 'claimController');
const { protect } = loadMod('middleware', 'auth');

const router = express.Router();

router.route('/')
  .post(protect, fileClaim);

router.route('/:shipmentId')
  .get(protect, getClaimByShipmentId);

module.exports = router;
