const express = require('express');
const { signup, login, sendOtp, verifyOtp, sendEmailOtp, verifyEmailOtp, logout } = require('../controllers/authController');

const router = express.Router();

router.post('/signup', signup);
router.post('/login', login);
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/send-email-otp', sendEmailOtp);
router.post('/verify-email-otp', verifyEmailOtp);
router.post('/logout', logout);

module.exports = router;
