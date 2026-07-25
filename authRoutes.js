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
  return require(`./${target}`);
}

const authController = loadModule('authController');

const router = express.Router();
router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.post('/send-otp', authController.sendOtp);
router.post('/verify-otp', authController.verifyOtp);
router.post('/send-email-otp', authController.sendEmailOtp);
router.post('/verify-email-otp', authController.verifyEmailOtp);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/logout', authController.logout);

module.exports = router;
