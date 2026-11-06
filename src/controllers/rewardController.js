const User = require('../models/User');
const Reward = require('../models/Reward');
const rewardService = require('../services/rewardService');
const { getActiveShipmentsCount, calculateSecurityReserve } = require('../utils/securityReserve');

/**
 * @desc    Get user's cashback balance & reward history
 * @route   GET /api/v1/rewards/wallet
 * @access  Private
 */
const getRewardWallet = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const history = await Reward.find({ userId: req.user._id }).sort({ createdAt: -1 });
    const isSupplier = user.role === 'Supplier';
    const supplierWallet = isSupplier ? await rewardService.computeSupplierWallet(req.user._id) : null;

    // user.walletBalance holds credits from direct recharges & order adjustments.
    // Sellers must maintain a minimum reserve buffer for active shipments.
    const directWalletCredits = parseFloat((Number(user.walletBalance) || 0).toFixed(2));
    const activeShipmentsCount = isSupplier ? await getActiveShipmentsCount(req.user._id) : 0;
    const securityReserve = isSupplier ? calculateSecurityReserve(activeShipmentsCount) : 0;
    const withdrawableDirectCredits = Math.max(0, parseFloat((directWalletCredits - securityReserve).toFixed(2)));

    // For suppliers: withdrawable from shipping wallet (after reserve) + cashback
    // For buyers: withdrawable from order balance (walletBalance) + cashback
    const cashback = parseFloat((Number(user.cashbackBalance) || 0).toFixed(2));
    const withdrawableBalance = parseFloat((withdrawableDirectCredits + cashback).toFixed(2));
    const pendingConfirmationBalance = supplierWallet ? supplierWallet.pendingConfirmationBalance : 0;
    const totalWalletBalance = parseFloat((directWalletCredits + cashback).toFixed(2));

    res.json({
      cashbackBalance: cashback,
      walletBalance: directWalletCredits,
      withdrawableBalance,
      pendingConfirmationBalance,
      totalWalletBalance,
      activeShipmentsCount,
      securityReserve,
      reservePerShipment: 100,
      maxReserveCap: 1000,
      confirmationPipeline: supplierWallet ? supplierWallet.confirmationPipeline : [],
      supplierWallet: supplierWallet || null,
      bankDetails: user.bankDetails || {},
      history: history || []
    });
  } catch (error) {
    console.error('Get Reward Wallet Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @desc    Request withdrawal of cashback balance to Bank or UPI
 * @route   POST /api/v1/rewards/withdraw
 * @access  Private
 */
const requestWithdrawal = async (req, res) => {
  try {
    const { amount, method, payoutDetails } = req.body;

    if (!amount || !method) {
      return res.status(400).json({ error: 'Please provide withdrawal amount and method (BANK or UPI)' });
    }

    const isMobileApp = Boolean(
      req.headers['x-client-platform'] === 'mobile-app' ||
      req.headers['x-request-source'] === 'mobile-app' ||
      req.body.isMobileApp === true
    );

    const result = await rewardService.withdrawCashback(
      req.user._id,
      amount,
      method,
      payoutDetails,
      isMobileApp
    );

    res.json({
      message: 'Withdrawal processed successfully',
      cashbackBalance: result.cashbackBalance,
      withdrawal: result.withdrawal
    });
  } catch (error) {
    console.error('Request Withdrawal Error:', error.message);
    const isAppDownloadRequired = error.message.includes('APP_DOWNLOAD_REQUIRED');
    const cleanError = error.message.replace('APP_DOWNLOAD_REQUIRED: ', '');

    res.status(isAppDownloadRequired ? 403 : 400).json({
      error: cleanError,
      appDownloadRequired: isAppDownloadRequired,
      downloadLinks: isAppDownloadRequired ? {
        android: 'https://play.google.com/store/apps/details?id=in.securekaro.app',
        ios: 'https://apps.apple.com/app/securekaro/id123456789'
      } : undefined
    });
  }
};

module.exports = {
  getRewardWallet,
  requestWithdrawal
};
