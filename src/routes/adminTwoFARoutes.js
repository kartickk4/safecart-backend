/**
 * adminTwoFARoutes.js
 * All routes are protected: JWT (protect) + admin role (admin) are required.
 *
 * Route Map:
 *   GET  /api/v1/auth/admin/2fa/status   → is 2FA enabled?
 *   POST /api/v1/auth/admin/2fa/setup    → generate TOTP secret + QR code
 *   POST /api/v1/auth/admin/2fa/enable   → verify first code → activate
 *   POST /api/v1/auth/admin/2fa/verify   → verify code → return 2FA session token
 *   POST /api/v1/auth/admin/2fa/disable  → disable & erase 2FA (needs TOTP proof)
 *
 * NOTE: requireAdmin2FA is intentionally NOT applied here — these routes are the
 * bootstrap and verification paths for 2FA itself, so blocking them behind 2FA
 * would create a chicken-and-egg deadlock.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');

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

const { protect, admin } = loadMod('middleware', 'auth');
const { setup2FA, enable2FA, verify2FA, disable2FA, status2FA } =
  loadMod('controllers', 'twoFAController');

const router = express.Router();

// All 2FA management routes require: valid JWT + Admin role
router.use(protect);
router.use(admin);

router.get ('/status',  status2FA);
router.post('/setup',   setup2FA);
router.post('/enable',  enable2FA);
router.post('/verify',  verify2FA);
router.post('/disable', disable2FA);

module.exports = router;
