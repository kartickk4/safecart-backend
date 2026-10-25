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
  return require(`../controllers/${target}`);
}

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

const authController = loadModule('authController');
const { protect } = loadMod('middleware', 'auth');
const { validate } = loadMod('middleware', 'validate');
const {
  signupSchema,
  loginSchema,
  sendOtpSchema,
  verifyOtpSchema,
  sendEmailOtpSchema,
  verifyEmailOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema
} = loadMod('validators', 'authValidator');

const router = express.Router();
router.post('/signup', validate(signupSchema), authController.signup);
router.post('/login', validate(loginSchema), authController.login);
router.post('/send-otp', validate(sendOtpSchema), authController.sendOtp);
router.post('/verify-otp', validate(verifyOtpSchema), authController.verifyOtp);
router.post('/send-email-otp', validate(sendEmailOtpSchema), authController.sendEmailOtp);
router.post('/verify-email-otp', validate(verifyEmailOtpSchema), authController.verifyEmailOtp);
router.post('/forgot-password', validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);
router.post('/google', authController.googleAuth);
router.post('/switch-role', protect, authController.switchRole);
router.post('/logout', authController.logout);

module.exports = router;
