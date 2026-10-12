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
  createRechargeOrder,
  verifyPayment,
  getWalletBalance,
  getTransactions,
  handleWebhook,
  withdrawCashback,
  withdrawWallet
} = loadMod('controllers', 'walletController');

const { protect } = loadMod('middleware', 'auth');

const router = express.Router();

router.post('/create-order', protect, createRechargeOrder);
router.post('/verify', protect, verifyPayment);
router.get('/balance', protect, getWalletBalance);
router.get('/transactions', protect, getTransactions);
router.post('/webhook', handleWebhook);

// Withdrawal routes
router.post('/buyer/withdraw', protect, withdrawCashback);   // Buyer cashback: <₹100 → ₹3 fee
router.post('/seller/withdraw', protect, withdrawWallet);    // Seller wallet: <₹2000 → ₹2 fee

module.exports = router;
