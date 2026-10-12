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

const { 
  getProfile, 
  updateProfile, 
  upgradeProPlan, 
  getReferralStats,
  sendPhoneVerificationOtp,
  verifyPhoneOtp,
  applyReferralCode
} = loadMod('controllers', 'profileController');
const { protect } = loadMod('middleware', 'auth');

const router = express.Router();

router.route('/')
  .get(protect, getProfile)
  .put(protect, updateProfile);

router.route('/upgrade-pro')
  .post(protect, upgradeProPlan);

router.route('/referral-stats')
  .get(protect, getReferralStats);

router.route('/apply-referral')
  .post(protect, applyReferralCode);

router.route('/send-phone-otp')
  .post(protect, sendPhoneVerificationOtp);

router.route('/verify-phone-otp')
  .post(protect, verifyPhoneOtp);

module.exports = router;
