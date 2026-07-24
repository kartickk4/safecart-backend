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

const claimController = loadModule('claimController');

const router = express.Router();
router.post('/', claimController.fileClaim);
router.get('/', claimController.getClaims);
router.get('/:id', claimController.getClaimById);

module.exports = router;
